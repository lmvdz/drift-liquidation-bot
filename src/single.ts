"use strict";

import { atob } from './util/atob.js';
import fs from 'fs-extra'
import { default as _ } from './clearingHouse.js'
import * as anchor from "@project-serum/anchor";
import { 
    UserPositionsAccount, 
    BN_MAX,
    calculateBaseAssetValue,
    calculatePositionFundingPNL,
    ClearingHouse,
    Market,
    PRICE_TO_QUOTE_PRECISION,
    TEN_THOUSAND,
    UserAccount,
    UserPosition,
    ZERO,
    BN,
    Markets,
    UserOrdersAccount,
    StateAccount,
    LiquidationHistoryAccount,
    FundingRateHistoryAccount,
    MarketsAccount,
    calculateMarkPrice,
    convertToNumber,
    MARK_PRICE_PRECISION,
    MARGIN_PRECISION
} from '@drift-labs/sdk';
import axios from 'axios';
import { AccountMeta, Connection, ConnectionConfig, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { PollingAccountsFetcher } from "polling-account-fetcher";
import { TpuConnection } from 'tpu-client'

import { config } from 'dotenv';
import { getLiquidationChart, getLiquidatorProfitTables, Liquidation, mapHistoryAccountToLiquidationsArray, updateLiquidatorMap } from './liqHistoryVisualizer.js';
import { getTable } from './util/table.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program } from '@project-serum/anchor';

config({path: './.env.local'});

// how many minutes before users will be fetched from storage
// the getUsersLoop.ts script will update the storage every minute
const userUpdateTimeInMinutes = 2

// how many minutes is considered one loop for the worker
// console will be cleared and new table/chart data will be displayed
const workerLoopTimeInMinutes = 1


// check priority every X ms
const highPrioCheckUsersEveryMS = 5


// unused
// the slippage of partial liquidation as a percentage --- 12 = 12% = 0.12 => when margin ratio reaches 625 * (1 + 0.12) = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 2

const slipLiq = (marginRequirement) => new BN(marginRequirement.toNumber() * (1 + (partialLiquidationSlippage/100)));

// the liquidation distance determines which priority bucket the user will be a part of.
// liquidation distance is totalCollateral / partialMarginRequirement
const highPriorityLiquidationDistance = 1.5
const mediumPriorityLiquidationDistance = 3

interface User {
    publicKey: string,
    authority: string,
    positions: string,
    orders: string,
    accountData: UserAccount, 
    positionsAccountData: UserPositionsAccount,
    ordersAccountData: UserOrdersAccount,
    liquidationInstruction: TransactionInstruction,
    marginRatio: BN,
    partialMarginRequirement: BN,
    totalPositionValue: BN,
    unrealizedPNL: BN,
    totalCollateral: BN,
    prio: Priority
}

enum Priority {
    'high',
    'medium',
    'low'
}

function sleep(milliseconds) {  
    return new Promise(resolve => setTimeout(resolve, milliseconds));  
}

function chunkArray(array : Array<any>, chunk_size : number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
} 

function flatDeep(arr : Array<any>, d = 1) : Array<any> {
    return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flatDeep(val, d - 1) : val), []) : arr.slice();
}


// used for the funding table
interface MarketFunding {
    marketId: number,
    marketSymbol: string,
    ts: number,
    rate: string
}

const blacklistAuthority = ['5jdnNir8fdbQPjFvUxNJsXEKL25Z5FnzGv3aWGDVSwZr']

interface ClearingHouseData {
    state: string,
    stateAccount: StateAccount,
    liquidationHistory: string,
    liquidationHistoryAccount: LiquidationHistoryAccount,
    fundingRateHistory: string,
    fundingRateHistoryAccount: FundingRateHistoryAccount,
    markets: string,
    marketsAccount: MarketsAccount
}

interface LiquidationMath {
    totalPositionValue: BN, 
    unrealizedPNL: BN, 
    marginRatio: BN, 
    partialMarginRequirement: BN,
    totalCollateral: BN

}

class Liquidator {
    intervals: Array<NodeJS.Timer> = [];
    usersToSetup: Array<User> = [];
    setupUsersTimeout: NodeJS.Timer = null
    intervalCount = 0
    numUsersChecked = new Array<number>();
    checkTime = new Array<number>();
    blockhashIndex = -1;
    recentBlockhashes : Map<number, string> = new Map<number, string>();
    ankr = new Connection('https://solana.public-rpc.com', { commitment: 'processed' });
    mainnetRPC = new Connection('https://api.mainnet-beta.solana.com', { commitment: 'processed' });
    rpcPool = new Connection('https://free.rpcpool.com', { commitment: 'processed' } );
    tpuConnection: TpuConnection
    clearingHouse: ClearingHouse
    clearingHouseData: ClearingHouseData
    liquidatorAccountPublicKey: PublicKey
    accountSubscriberBucketMap : Map<Priority, PollingAccountsFetcher>
    userMap : Map<string, User>
    lowPriorityBucket: PollingAccountsFetcher
    mediumPriorityBucket: PollingAccountsFetcher
    highPriorityBucket: PollingAccountsFetcher
    clearingHouseSubscriber: PollingAccountsFetcher
    liquidationGroup: Set<string>
    

    static async setupClearingHouseData(clearingHouse: ClearingHouse) {
        const barebonesClearingHouse = {} as ClearingHouseData;
        barebonesClearingHouse.state = (await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode('clearing_house'))], clearingHouse.program.programId))[0].toBase58();
        const stateAccount = (await axios.post(process.env.RPC_URL, [{
            jsonrpc: "2.0",
            id: "1",
            method: "getMultipleAccounts",
            params: [
                [barebonesClearingHouse.state],
                {
                commitment: "processed",
                },
            ]
        }])).data[0].result.value[0].data;
        const raw: string = stateAccount[0];
        const dataType = stateAccount[1]
        const buffer = Buffer.from(raw, dataType);
        barebonesClearingHouse.stateAccount = clearingHouse.program.account[
            'state'
        ].coder.accounts.decode(
            // @ts-ignore
            clearingHouse.program.account['state']._idlAccount.name,
            buffer
        ) as StateAccount;
        
        barebonesClearingHouse.markets = barebonesClearingHouse.stateAccount.markets.toBase58();
        barebonesClearingHouse.fundingRateHistory = barebonesClearingHouse.stateAccount.fundingRateHistory.toBase58();
        barebonesClearingHouse.liquidationHistory = barebonesClearingHouse.stateAccount.liquidationHistory.toBase58();
    
        const secondaryAccounts = (await axios.post(process.env.RPC_URL, [{
            jsonrpc: "2.0",
            id: "1",
            method: "getMultipleAccounts",
            params: [
                [barebonesClearingHouse.markets, barebonesClearingHouse.fundingRateHistory, barebonesClearingHouse.liquidationHistory],
                {
                    commitment: "processed",
                },
            ]
        }])).data[0].result.value;

        const marketsRaw: string = secondaryAccounts[0].data[0];
        const marketsDataType = secondaryAccounts[0].data[1]
        const marketsBuffer = Buffer.from(marketsRaw, marketsDataType);
        barebonesClearingHouse.marketsAccount = clearingHouse.program.account[
            'markets'
        ].coder.accounts.decode(
            // @ts-ignore
            clearingHouse.program.account['markets']._idlAccount.name,
            marketsBuffer
        ) as MarketsAccount;
    
    
        const fundingRateHistoryRaw: string = secondaryAccounts[1].data[0];
        const fundingRateHistoryDataType = secondaryAccounts[1].data[1]
        const fundingRateHistoryBuffer = Buffer.from(fundingRateHistoryRaw, fundingRateHistoryDataType);
        barebonesClearingHouse.fundingRateHistoryAccount = clearingHouse.program.account[
            'fundingRateHistory'
        ].coder.accounts.decode(
            // @ts-ignore
            clearingHouse.program.account['fundingRateHistory']._idlAccount.name,
            fundingRateHistoryBuffer
        ) as FundingRateHistoryAccount;
    
    
        const liquidationHistoryRaw: string = secondaryAccounts[2].data[0]
        const liquidationHistoryDataType = secondaryAccounts[2].data[1]
        const liquidationHistoryBuffer = Buffer.from(liquidationHistoryRaw, liquidationHistoryDataType);
        barebonesClearingHouse.liquidationHistoryAccount = clearingHouse.program.account[
            'liquidationHistory'
        ].coder.accounts.decode(
            // @ts-ignore
            clearingHouse.program.account['liquidationHistory']._idlAccount.name,
            liquidationHistoryBuffer
        ) as LiquidationHistoryAccount;
    
        return barebonesClearingHouse;
    }
    static async load() {

        const  tpuConnection = await TpuConnection.load(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 30 * 1000 } as ConnectionConfig );
        // const tpuConnection = new Connection(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 30 * 1000 } as ConnectionConfig )
        const  clearingHouse = _.createClearingHouse(tpuConnection);
        const  liquidatorAccountPublicKey = (await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode('user')), clearingHouse.wallet.publicKey.toBuffer()], clearingHouse.program.programId))[0]
        const  clearingHouseData = await Liquidator.setupClearingHouseData(clearingHouse);

        return new Liquidator(tpuConnection, clearingHouse, clearingHouseData, liquidatorAccountPublicKey);
    }
    constructor(tpuConnection: TpuConnection, clearingHouse: ClearingHouse, clearingHouseData: ClearingHouseData, liquidatorAccountPublicKey: PublicKey) {

        // setInterval(async () => {
        //     console.log([...this.recentBlockhashes.values()])
        // }, 100)

        this.tpuConnection = tpuConnection;
        this.clearingHouse = clearingHouse;
        this.clearingHouseData = clearingHouseData;
        this.liquidatorAccountPublicKey = liquidatorAccountPublicKey;

        this.accountSubscriberBucketMap = new Map<Priority, PollingAccountsFetcher>();
        this.userMap = new Map<string, User>();

        // poll low priority accounts every 5 minutes
        this.lowPriorityBucket = new PollingAccountsFetcher(process.env.RPC_URL, 60 * 1000);
        this.accountSubscriberBucketMap.set(Priority.low, this.lowPriorityBucket)

        // poll medium priority accounts every minute
        this.mediumPriorityBucket = new PollingAccountsFetcher(process.env.RPC_URL, 10 * 1000);
        this.accountSubscriberBucketMap.set(Priority.medium, this.mediumPriorityBucket)

        this.highPriorityBucket = new PollingAccountsFetcher(process.env.RPC_URL, 5000);
        this.accountSubscriberBucketMap.set(Priority.high, this.highPriorityBucket)

        this.clearingHouseSubscriber = new PollingAccountsFetcher(process.env.RPC_URL, 500);

        this.liquidationGroup = new Set<string>();

        this.clearingHouseSubscriber.addProgram('state', this.clearingHouseData.state, this.clearingHouse.program as any, (data: StateAccount) => {
            // console.log('updated clearingHouse state');
            this.clearingHouseData.stateAccount = data;
        }, (error: any) => {
            console.log('here2');
            console.error(error);
        });

        // this needs to update as fast a possible to get the most up to date margin ratio.
        this.clearingHouseSubscriber.addProgram('markets', this.clearingHouseData.markets, this.clearingHouse.program as any, (data: MarketsAccount) => {
            // console.log('updated clearingHouse markets');
            this.clearingHouseData.marketsAccount = data;
        }, (error: any) => {
            console.log('here3');
            console.error(error);
        });

        this.clearingHouseSubscriber.addProgram('liquidationHistory', this.clearingHouseData.liquidationHistory, this.clearingHouse.program as any,  (data: LiquidationHistoryAccount) => {
            // console.log('updated clearingHouse liquidationHistory');
            this.clearingHouseData.liquidationHistoryAccount = data;
        }, (error: any) => {
            console.log('here4');
            console.error(error);
        });

        this.clearingHouseSubscriber.addProgram('fundingRateHistory', this.clearingHouseData.fundingRateHistory, this.clearingHouse.program as any,  (data: FundingRateHistoryAccount) => {
            // console.log('updated clearingHouse fundingRate');
            this.clearingHouseData.fundingRateHistoryAccount = data;
        }, (error: any) => {
            console.log('here5');
            console.error(error);
        });
        
        this.setupUsers(this.getUsers().map(u => u as User)).then(() => {
            
            this.accountSubscriberBucketMap.forEach(bucket => bucket.start());
            this.clearingHouseSubscriber.start();

        })
    }
    loop() {
        try {
            this.start();
        } catch(error) {
            this.stop();
            this.loop();
        }
    }
    stop() {
        this.intervals.forEach(i => clearInterval(i))
    }
    start () {
        // setup new users every minute
        this.intervals.push(setInterval(async function(){
            const liquidator = (this as Liquidator);
            liquidator.setupUsers(liquidator.getUsers().map(u => u as User))
        }.bind(this), 60 * 1000));
        

        this.intervals.push(setInterval(async function(){
            const liquidator = (this as Liquidator);
            liquidator.sortUsers();
        }.bind(this), (60 * 1000)));

        // get blockhashes of multiple rpcs every second
        // this.intervals.push(setInterval(async function(){
        //     const liquidator = (this as Liquidator);
        //     try {
        //         await liquidator.getBlockhash();
        //     } catch (error) {
        //         console.error(error);
        //     }
        // }.bind(this), 1000));

        // check the highPriorityBucket every x seconds
        this.intervals.push(setInterval(async function() {

            const liquidator = (this as Liquidator);

            liquidator.liquidationGroup.forEach(async liquidatee => {
                let user = liquidator.userMap.get(liquidatee);

                if (user === undefined) {
                    return liquidator.liquidationGroup.delete(liquidatee);  
                }

                user = { ...user, ...this.getLiquidationMath(user) };

                if (user.totalCollateral.gt(slipLiq(user.partialMarginRequirement))) {
                    return liquidator.liquidationGroup.delete(liquidatee);
                }
                
                liquidator.liquidate(user);
                this.userMap.set(user.publicKey, user);
            });

            liquidator.checkBucket(this.highPriorityBucket)
            liquidator.intervalCount++;

        }.bind(this), highPrioCheckUsersEveryMS));


        // print the memory usage every 5 seconds
        this.intervals.push(setInterval(async function () {
            // console.clear();
            console.log(`total mem usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`)
            // console.log(`low: ${lowPriorityBucket.getAllKeys().length}, medium: ${mediumPriorityBucket.getAllKeys().length}, high: ${highPriorityBucket.getAllKeys().length}`)
        }.bind(this), 10 * 1000));


        // print out the tables every x minutes
        this.intervals.push(setInterval(async function () {
            const liquidator = (this as Liquidator);
            const margin = [...liquidator.userMap.values()].map(u => u.marginRatio.toNumber())
            const data = {
                userCount: liquidator.userMap.size,
                prio: {
                    high: liquidator.highPriorityBucket.accounts.size,
                    medium: liquidator.mediumPriorityBucket.accounts.size,
                    low: liquidator.lowPriorityBucket.accounts.size
                },
                // intervalCount: intervalCount,
                // checked: numUsersChecked,
                margin: Math.min(...margin) / 100,
                // time: checkTime.reduce((a, b) => a+b, 0).toFixed(2) 
            }

            liquidator.print(data).then(() => {
                liquidator.intervalCount = 0
                liquidator.numUsersChecked = new Array<number>();
                liquidator.checkTime = new Array<number>();
            })

        }.bind(this), 60 * 1000 * workerLoopTimeInMinutes));
    }
    async getBlockhash() : Promise<void> {
        try {
            this.recentBlockhashes.set(0, (await axios.post('https://demo.theindex.io', {"jsonrpc":"2.0","id":1, "method":"getRecentBlockhash", "params": [ { commitment: 'processed'}] })).data.result.value.blockhash);
        } catch (error) {}
        try { this.recentBlockhashes.set(1, (await this.clearingHouse.connection.getRecentBlockhash()).blockhash); } catch (error) {}
        try { this.recentBlockhashes.set(2, (await this.mainnetRPC.getRecentBlockhash()).blockhash); } catch (error) {}
        try { this.recentBlockhashes.set(3, (await this.rpcPool.getRecentBlockhash()).blockhash); } catch (error) {}
        try { this.recentBlockhashes.set(4, (await this.ankr.getRecentBlockhash()).blockhash); } catch (error) {}
    }
    getUsers() {
        if (fs.pathExistsSync('./storage/programUserAccounts')) {
            let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
            usersFromFile = (JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string, positions: string }>);
            return usersFromFile;
        } else {
            console.error('storage/programUserAccounts doesn\'t exist.... if the file is there and isn\'t empty, just start the bot again!')
            console.error('try using "npm run getUsers" before running the bot')
            process.exit();
        }
    }
    async print (data : any) {
        const liquidatorMap = await updateLiquidatorMap(mapHistoryAccountToLiquidationsArray(this.clearingHouseData.liquidationHistoryAccount))
        const liquidationChart = getLiquidationChart(liquidatorMap, [this.liquidatorAccountPublicKey.toBase58()])
        const liquidationTables = getLiquidatorProfitTables(liquidatorMap, [this.liquidatorAccountPublicKey.toBase58()])
        console.clear();
        // Promise.all([...unrealizedPNLMap].sort((a : [string, string], b: [string, string]) => {
        //     return parseInt(b[1]) - parseInt(a[1]);
        // }).slice(0, 10).map(([pub, val]) => {
        //     return new Promise((resolve) => {
        //         clearingHouse.program.account.user.fetch(new PublicKey(pub)).then((userAccount) => {
        //             clearingHouse.program.account.userPositions.fetch((userAccount as UserAccount).positions).then(userPositionsAccount => {
        //                resolve(
        //                    { 
        //                        pub,
        //                        positions: (userPositionsAccount as UserPositionsAccount).positions.filter((p : UserPosition) => p.baseAssetAmount.gt(ZERO) || p.baseAssetAmount.lt(ZERO)).map(p => {
        //                         let z = {
        //                             marketIndex: p.marketIndex.toNumber(),
        //                             baseAssetAmount: convertBaseAssetAmountToNumber(p.baseAssetAmount),
        //                             qouteAssetAmount: convertToNumber(p.quoteAssetAmount, QUOTE_PRECISION),
        //                             baseAssetValue: convertToNumber(calculateBaseAssetValue(clearingHouse.getMarket(p.marketIndex.toNumber()), p), QUOTE_PRECISION),
        //                             entryPrice: 0,
        //                             profit: 0
        //                         };
        //                         z.entryPrice = (z.qouteAssetAmount/z.baseAssetAmount) * (z.baseAssetAmount < 0 ? -1 : 1)
        //                         z.profit = (z.baseAssetValue - z.qouteAssetAmount) * (z.baseAssetAmount < 0 ? -1 : 1)
        //                         return JSON.stringify(z);
        //                     })
        //                 }
        //                )
        //             })
        //         })
        //     })
        // })).then(promises => {
        //     console.log(promises);
        // })
        console.log([getTable([{
                    "User Count": parseFloat(data.userCount),
                    "High Prio": parseInt(data.prio.high),
                    "Medium Prio": parseInt(data.prio.medium),
                    "Low Prio": parseInt(data.prio.low),
                    // "Times Checked": parseFloat(data.intervalCount),
                    // "Total MS": parseFloat(data.time),
                    // "User Check MS": parseFloat(data.time) / (data.intervalCount *  (data.userCount)),
                    "Min Margin %": data.margin
                }]), [getTable(this.getMarketData())], [...liquidationTables].map(t => getTable(t)), liquidationChart].flat().join("\n\n"))
    }
    getMarketData() {
        // reset the funding rate map, keep memory low
        const fundingRateMap : Map<string, Array<MarketFunding>> = new Map<string, Array<MarketFunding>>();
        let fundingTable = [];
        const funding = this.clearingHouseData.fundingRateHistoryAccount.fundingRateRecords

        funding.map(record => {
            return {
                marketId: record.marketIndex.toNumber(),
                marketSymbol: Markets[record.marketIndex.toNumber()].symbol,
                ts: record.ts.toNumber(),
                rate: ((record.fundingRate.toNumber() / record.oraclePriceTwap.toNumber()) * (365.25 * 24) / 100).toFixed(2) + " %"
            } as MarketFunding
        }).sort((a, b) => {
            return b.ts - a.ts
        }).sort((a, b) => {
            return a.marketId - b.marketId
        }).forEach(record => {
            if (!fundingRateMap.has(record.marketSymbol)) {
                fundingRateMap.set(record.marketSymbol, new Array<MarketFunding>());
            }
            let marketFundingArray = fundingRateMap.get(record.marketSymbol);
            marketFundingArray.push(record);
            fundingRateMap.set(record.marketSymbol, marketFundingArray)
        });
    
        [...fundingRateMap.keys()].forEach(key => {
            fundingTable.push(fundingRateMap.get(key)[0])
        });

        const markPriceMap = Markets.map(market => {
            return {
                marketSymbol: market.symbol,
                markPrice: convertToNumber(calculateMarkPrice(this.clearingHouseData.marketsAccount.markets[market.marketIndex.toNumber()]), MARK_PRICE_PRECISION)
            }
        });

    
        return fundingTable.map((lastFundingRate : MarketFunding) => {
            return {
                "Market": lastFundingRate.marketSymbol,
                "Funding Rate (APR)": lastFundingRate.rate,
                "Market Price": markPriceMap.find(m => m.marketSymbol === lastFundingRate.marketSymbol).markPrice.toFixed(4)
            }
        });
    
    }
    async setupUser (u : User) {
        if (u !== undefined) {
            if (!this.usersToSetup.includes(u)) {
                this.usersToSetup.push(u);
            }
            clearTimeout(this.setupUsersTimeout)
            this.setupUsersTimeout = setTimeout(() => {
                console.log('setting up users');
                // const startTime = process.hrtime();
                this.setupUsers(this.usersToSetup).then(() => {
                    this.usersToSetup = [];
                    // const endTime = process.hrtime(startTime);
                    // console.log('took ' + endTime[0] * 1000  + ' ms');
                    [...this.accountSubscriberBucketMap.keys()].forEach(key => this.accountSubscriberBucketMap.get(key).start());
                });
            }, 2000)
        }
        
    }
    async setupUsers (users: Array<User>) {
        let usersSetup = []

        usersSetup = chunkArray(await Promise.all(users.filter(u => !this.userMap.has(u.publicKey)).map(async (u, index) => {
            return {
                index,
                ...u
            }
        })), 100)

        const data = flatDeep(usersSetup.map(chunk => ([
            {
                jsonrpc: "2.0",
                id: "1",
                method: "getMultipleAccounts",
                params: [
                    chunk.map(u => u.publicKey),
                    {
                    commitment: "processed",
                    },
                ]
            }, 
            {
                jsonrpc: "2.0",
                id: "1",
                method: "getMultipleAccounts",
                params: [
                    chunk.map(u => u.positions),
                    {
                    commitment: "processed",
                    },
                ]
            }
        ])), Infinity)
        const chunkedData = chunkArray(data, 10);
        const chunkedRequests = chunkArray(chunkedData, 5);

        const responses = flatDeep(await Promise.all(chunkedRequests.map((request, index) => 
                new Promise((resolve) => {
                    setTimeout(() => {
                        // console.log(index);
                        Promise.all(request.map(dataChunk => (
                            new Promise((resolveInner) => {
                                //@ts-ignore
                                axios.post(this.tpuConnection._rpcEndpoint, dataChunk).then(response => {
                                    resolveInner(response.data);
                                })
                            })
                        ))).then(responses => {
                            resolve(flatDeep(responses, Infinity))
                        });
                    }, index * 1000)
                })
            )), 
            Infinity
        )

        for(let x = 0; x < responses.length/2; x++) {
            const userAccounts = responses[x*2]
            const userPositionAccounts = responses[(x*2) + 1]
            const mappedUserAccounts = userAccounts.result.value.map(u =>  {
                const raw: string = u.data[0];
                const dataType = u.data[1]
                const buffer = Buffer.from(raw, dataType);
                return this.clearingHouse.program.account['user'].coder.accounts.decode(
                    // @ts-ignore
                    this.clearingHouse.program.account['user']._idlAccount.name, 
                    buffer
                ) as UserAccount
            })
            
            const mappedUserPositionAccounts = userPositionAccounts.result.value.map(p => {
                const raw: string = p.data[0];
                const dataType = p.data[1]
                const buffer = Buffer.from(raw, dataType);
                return this.clearingHouse.program.account[
                    'userPositions'
                ].coder.accounts.decode(
                    // @ts-ignore
                    this.clearingHouse.program.account['userPositions']._idlAccount.name,
                    buffer
                ) as UserPositionsAccount
            })

            Promise.all(usersSetup[x].map((u, i) => {
                let user = {
                    ...u,
                    accountData: mappedUserAccounts[i],
                    positionsAccountData: mappedUserPositionAccounts[i]
                }
                user = { ...user, ...this.getLiquidationMath(user) };
                setTimeout(() => {
                    this.prepareUserLiquidationIX(user)
                }, 1000 * i)
                this.userMap.set(user.publicKey, user);
                this.sortUser(user)
            }))
        }
    }
    async sortUsers () {
        const users = [...this.userMap.values()];
        console.log('sorting ' + users.length + ' users');
        users.forEach(async user => this.sortUser(user));
    }
    async sortUser(user: User) {
        user = { ...user, ...this.getLiquidationMath(user) };
        let currentPrio = user.prio;
        let newPrio = this.getPrio(user);
        if (currentPrio !== newPrio) {
            if (currentPrio !== undefined)
            this.accountSubscriberBucketMap.get(currentPrio).accounts.delete(user.publicKey)

            this.userMap.set( user.publicKey, { ...user, prio: newPrio } )

            this.accountSubscriberBucketMap.get( newPrio ).addProgram('user', user.publicKey, this.clearingHouse.program as any, (data: UserAccount) => {
                // console.log('updated user account data', user.publicKey);
                this.userMap.set(user.publicKey, { ...this.userMap.get(user.publicKey), accountData: data } as User);
                this.sortUser(this.userMap.get(user.publicKey));
            }, (error: any) => {
                console.error(error);
                // delete the user from the map to get it picked up next time :)
                // this.userMap.delete(user.publicKey);
            });

            this.accountSubscriberBucketMap.get(newPrio).addProgram('userPositions', user.positions, this.clearingHouse.program as any, (data: UserPositionsAccount) => {
                // console.log('updated user positions data', data.user.toBase58());
                const oldData = this.userMap.get(user.publicKey);
                let newData = { ...oldData, positionsAccountData: data } as User;
                newData = { ...newData, ...this.getLiquidationMath(newData) };
                this.userMap.set(user.publicKey, newData);
                this.prepareUserLiquidationIX(newData);
                this.sortUser(newData);
            }, (error: any) => {
                console.error(error);
                // delete the user from the map to get it picked up next time :)
                // this.userMap.delete(user.publicKey);
            });

        }
    }
    /**
     * Calculate the priority of the user based on their marginRatio and marginRequirement
     * @param {User} user the user which we are checking the priority of
     * @returns {Priority} enum
     */
    getPrio(user: User) {
        if (!user.partialMarginRequirement.eq(ZERO)) {
            
            const liqDistance = user.totalCollateral.toNumber() / user.partialMarginRequirement.toNumber();

            return (liqDistance <= highPriorityLiquidationDistance ? Priority.high : liqDistance <= mediumPriorityLiquidationDistance ? Priority.medium : Priority.low);

        } else {

            return Priority.low

        }
    }

    getLiquidateIx(
        user: User,
    ): TransactionInstruction {
        const liquidateeUserAccountPublicKey = new PublicKey(user.publicKey);
            const liquidateeUserAccount = user.accountData
            const liquidateePositions = user.positionsAccountData
            const markets = this.clearingHouseData.marketsAccount;
            const remainingAccounts = [];
            for (const position of liquidateePositions.positions) {
                if (!position.baseAssetAmount.eq(new BN(0))) {
                    const market = markets.markets[position.marketIndex.toNumber()];
                    remainingAccounts.push({
                        pubkey: market.amm.oracle,
                        isWritable: false,
                        isSigner: false,
                    });
                }
            }
            const state = this.clearingHouseData.stateAccount
            const keys = [
                {
                    pubkey: new PublicKey(this.clearingHouseData.state), 
                    "isWritable": false,
                    "isSigner": false
                },
                {
                    pubkey: this.clearingHouse.wallet.publicKey, 
                    "isWritable": false,
                    "isSigner": true
                },
                {
                    pubkey: this.liquidatorAccountPublicKey,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: liquidateeUserAccountPublicKey, 
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.collateralVault,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.collateralVaultAuthority,
                    "isWritable": false,
                    "isSigner": false
                },
                {
                    pubkey: state.insuranceVault,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.insuranceVaultAuthority,
                    "isWritable": false,
                    "isSigner": false
                },
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    "isWritable": false,
                    "isSigner": false
                },
                {
                    pubkey: state.markets,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: liquidateeUserAccount.positions,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.tradeHistory,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.liquidationHistory,
                    "isWritable": true,
                    "isSigner": false
                },
                {
                    pubkey: state.fundingPaymentHistory,
                    "isWritable": true,
                    "isSigner": false
                }
            ] as AccountMeta[]
            return new TransactionInstruction({
                data: this.clearingHouse.program.coder.instruction.encode('liquidate', []),
                programId: this.clearingHouse.program.programId,
                keys: keys.concat(remainingAccounts)
            });
    }
    calculatePositionPNL (
        market: Market,
        marketPosition: UserPosition,
        baseAssetValue: BN,
        withFunding = false
    ): BN {
        if (marketPosition.baseAssetAmount.eq(ZERO)) {
            return ZERO;
        }
    
        let pnlAssetAmount = (marketPosition.baseAssetAmount.gt(ZERO) ? baseAssetValue.sub(marketPosition.quoteAssetAmount) : marketPosition.quoteAssetAmount.sub(baseAssetValue));
    
        if (withFunding) {
            pnlAssetAmount = pnlAssetAmount.add(calculatePositionFundingPNL(
                market,
                marketPosition
            ).div(PRICE_TO_QUOTE_PRECISION));
        }
    
        return pnlAssetAmount;
    }


    getLiquidationMath( user: User ) : LiquidationMath {
        const positions = user.positionsAccountData.positions;
        
        if (positions.length === 0) {
            return { marginRatio: BN_MAX, totalPositionValue: ZERO, unrealizedPNL: ZERO, partialMarginRequirement: ZERO } as LiquidationMath;
        }
    
        let totalPositionValue = ZERO, unrealizedPNL = ZERO, partialMarginRequirement = ZERO
    
        positions.forEach(position => {
            const market = this.clearingHouseData.marketsAccount.markets[position.marketIndex.toNumber()];
            if (market !== undefined) {
                const baseAssetAmountValue = calculateBaseAssetValue(market, position);
                const marginRequirement = baseAssetAmountValue.mul(new BN(market.marginRatioPartial)).div(MARGIN_PRECISION);
                partialMarginRequirement = partialMarginRequirement.add(marginRequirement);
                totalPositionValue = totalPositionValue.add(baseAssetAmountValue);
                unrealizedPNL = unrealizedPNL.add(this.calculatePositionPNL(market, position, baseAssetAmountValue, true));
            } else {
                console.log(user.accountData.positions.toBase58(), user.publicKey);
                console.log(market, position.marketIndex.toString());
                console.log('market undefined', market);
            }
            
        })
    
        // unrealizedPnLMap.set(user.publicKey, unrealizedPNL.toString());
    
        if (totalPositionValue.eq(ZERO)) {
            return { marginRatio: BN_MAX, totalPositionValue: ZERO, unrealizedPNL: ZERO, partialMarginRequirement: ZERO } as LiquidationMath;
        }

        const totalCollateral = (
            user.accountData.collateral.add(unrealizedPNL) ??
            ZERO
        );

        const marginRatio = totalCollateral.mul(TEN_THOUSAND).div(totalPositionValue);

        return { totalCollateral, totalPositionValue, unrealizedPNL, marginRatio, partialMarginRequirement } ;
    }

    async checkForLiquidation (pub : string) {    
        let user = this.userMap.get(pub)
        if (!this.liquidationGroup.has(pub)) {
            if (user !== undefined) {
                user = { ...user, ...this.getLiquidationMath(user) };
                this.userMap.set(user.publicKey, user);
                if (user.totalCollateral.lte(slipLiq(user.partialMarginRequirement))) {
                    try {
                        this.liquidationGroup.add(pub);
                        this.liquidate(user);
                    } catch (error) {
                        console.error(error);
                    }
                }
            } else {
                this.userMap.delete(pub);
            }
        }
        
    }
    async checkBucket (bucket: PollingAccountsFetcher) {
        const start = process.hrtime();
        const keys = [...bucket.accounts.keys()];
        await Promise.all(keys.map(async (key) => await this.checkForLiquidation(key)))
        this.numUsersChecked.push(keys.length)
        const time = process.hrtime(start);
        this.checkTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
    }
    wrapInTx(instruction: TransactionInstruction) : Transaction {
        return new Transaction().add(instruction);
    }
    getLiquidationSize (user: User) {
        user.totalPositionValue
    }
    async liquidate(user: User) : Promise<void> {
        let instruction = user.liquidationInstruction
        if (instruction === undefined) {
            instruction = this.prepareUserLiquidationIX(user)
        }
        try {
            console.log('trying to liquiate: ' + user.authority, user.marginRatio.toNumber(), user.accountData.collateral.toNumber(), new Date(Date.now()), user.positionsAccountData.positions.length);
            let tx = this.wrapInTx(instruction);
            tx.recentBlockhash = (await this.tpuConnection.getRecentBlockhash()).blockhash;
            tx.feePayer = this.clearingHouse.wallet.publicKey;
            tx = await this.clearingHouse.wallet.signTransaction(tx);

            try {
                this.tpuConnection.tpuClient.sendRawTransaction(tx.serialize()); 
            } catch {
                this.prepareUserLiquidationIX(user);
            }

            try {
                this.tpuConnection.tpuClient.connection.sendRawTransaction(tx.serialize());
            } catch (error) {
                this.prepareUserLiquidationIX(user);
            }
            
            
            
        } catch (error) {
            this.prepareUserLiquidationIX(user);
        }
    }
    prepareUserLiquidationIX(user: User) : TransactionInstruction {
        const liquidationInstruction = this.getLiquidateIx(user);
        this.userMap.set(user.publicKey, { ...user, liquidationInstruction });
        return liquidationInstruction;
    }
}

Liquidator.load().then((liquidator) => {
    liquidator.loop();
})