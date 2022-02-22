import { atob } from './util/atob.js';
import fs from 'fs-extra'
import bs58 from 'bs58'
import { default as _ } from './clearingHouse.js'
import { 
    UserPositionsAccount, 
    BN_MAX,
    calculateBaseAssetValue,
    calculatePositionFundingPNL,
    ClearingHouse,
    Market,
    PARTIAL_LIQUIDATION_RATIO,
    PRICE_TO_QUOTE_PRECISION,
    TEN_THOUSAND,
    UserAccount,
    UserPosition,
    ZERO,
    BN,
    PollingAccountSubscriber,
    Markets,
    UserOrdersAccount} from '@drift-labs/sdk';
import { TpuConnection } from './tpuClient.js';
import axios from 'axios';
import { AccountMeta, Connection, ConnectionConfig, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';


import { config } from 'dotenv';
import { getLiquidationChart, getLiquidatorProfitTables, mapHistoryAccountToLiquidationsArray, updateLiquidatorMap } from './liqHistoryVisualizer.js';
import { getTable } from './util/table.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { isPropertyAccessChain } from 'typescript';
config({path: './.env.local'});

// how many minutes before users will be fetched from storage
// the getUsersLoop.ts script will update the storage every minute
const userUpdateTimeInMinutes = 2

// how many minutes is considered one loop for the worker
// console will be cleared and new table/chart data will be displayed
const workerLoopTimeInMinutes = 1


// check priority every X ms
const highPrioCheckUsersEveryMS = 5


// the slippage of partial liquidation as a percentage --- 12 = 12% = 0.12 => when margin ratio reaches 625 * (1 + 0.12) = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 0.5

const slipLiq = new BN(PARTIAL_LIQUIDATION_RATIO.toNumber() * (1 + (partialLiquidationSlippage/100)));

console.log(slipLiq.toNumber())

// the margin ratio which determines which priority bucket the user will be a part of 
const highPriorityMarginRatio = 1000
const mediumPriorityMarginRatio = 2000



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
    prio: Priority
}


const calculatePositionPNL = (
	market: Market,
	marketPosition: UserPosition,
    baseAssetValue: BN,
	withFunding = false
): BN  => {
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

const getMarginRatio = (clearingHouse : ClearingHouse, user: User) => {
    const positions = user.positionsAccountData.positions;
    

    if (positions.length === 0) {
        return BN_MAX;
    }

    let totalPositionValue = ZERO, unrealizedPNL = ZERO

    positions.forEach(position => {
        const market = clearingHouse.getMarket(position.marketIndex);
        if (market !== undefined) {
            const baseAssetAmountValue = calculateBaseAssetValue(market, position);
            totalPositionValue = totalPositionValue.add(baseAssetAmountValue);
            unrealizedPNL = unrealizedPNL.add(calculatePositionPNL(market, position, baseAssetAmountValue, true));
        } else {
            console.log(user.accountData.positions.toBase58(), user.publicKey);
            console.log(market, position.marketIndex.toString());
            console.log('market undefined', market);
        }
        
    })

    // unrealizedPnLMap.set(user.publicKey, unrealizedPNL.toString());

    if (totalPositionValue.eq(ZERO)) {
        return BN_MAX;
    }

    return (
        user.accountData.collateral.add(unrealizedPNL) ??
        ZERO
    ).mul(TEN_THOUSAND).div(totalPositionValue);
}

const checkForLiquidation = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, pub : string, tpuConnection: TpuConnection, liquidatorAccountPublicKey: PublicKey) => {    
    const user = userMap.get(pub)
    user.marginRatio = getMarginRatio(clearingHouse, user);
    userMap.set(user.publicKey, user);
    if (user.marginRatio.lte(slipLiq)) {
        try {
            liquidate(clearingHouse, userMap, user, tpuConnection, liquidatorAccountPublicKey);
        } catch (error) {
            console.error(error);
        }
        
    }
}

const checkBucket = async (clearingHouse : ClearingHouse, userMap: Map<string, User>, bucket: PollingAccountSubscriber, tpuConnection : TpuConnection, numUsersChecked: Array<number>, checkTime: Array<number>, liquidatorAccountPublicKey: PublicKey) => {
    const start = process.hrtime();
    const keys = bucket.getAllKeys();
    await Promise.all(keys.map(async (key) => await checkForLiquidation(clearingHouse, userMap, key, tpuConnection, liquidatorAccountPublicKey)))
    numUsersChecked.push(keys.length)
    const time = process.hrtime(start);
    checkTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
}


const wrapInTx = (instruction: TransactionInstruction) : Transaction  => {
	return new Transaction().add(instruction);
}


let recentBlockhashes : Set<string> = new Set<string>();

const liquidate = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, user: User, tpuConnection: TpuConnection, liquidatorAccountPublicKey: PublicKey) : Promise<void> => {
    let instruction = user.liquidationInstruction
    if (instruction === undefined) {
        instruction = await prepareUserLiquidationIX(clearingHouse, userMap, user, liquidatorAccountPublicKey)
    }
    try {
        console.log('trying to liquiate: ' + user.authority, user.marginRatio.toNumber(), user.accountData.collateral.toNumber(), new Date(Date.now()), user.positionsAccountData.positions.length);
        let tx = wrapInTx(instruction);
        [...recentBlockhashes.values()].forEach(async blkhash => {
            tx.recentBlockhash = blkhash;
            tx.feePayer = clearingHouse.wallet.publicKey
            tx = await clearingHouse.wallet.signTransaction(tx)
            tpuConnection.tpuClient.sendRawTransaction(tx.serialize())
        })
    } catch (error) {
        prepareUserLiquidationIX(clearingHouse, userMap, user, liquidatorAccountPublicKey);
    }
}

const prepareUserLiquidationIX = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, user: User, liquidatorAccountPublicKey: PublicKey) : Promise<TransactionInstruction> => {
    const liquidationInstruction = await getLiquidateIx(clearingHouse, user, liquidatorAccountPublicKey);
    userMap.set(user.publicKey, { ...user, liquidationInstruction });
    return liquidationInstruction;
}

const getLiquidateIx = (
    clearingHouse: ClearingHouse,
    user: User,
    liquidatorAccountPublicKey: PublicKey
): Promise<TransactionInstruction>  => {
    return new Promise((resolve) => {
        const liquidateeUserAccountPublicKey = new PublicKey(user.publicKey);
        const liquidateeUserAccount = user.accountData
        const liquidateePositions = user.positionsAccountData
        const markets = clearingHouse.getMarketsAccount();
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
        const state = clearingHouse.getStateAccount();
        clearingHouse.getStatePublicKey().then(statePublicKey => {
            const keys = [
                {
                    pubkey: statePublicKey, 
                    "isWritable": false,
                    "isSigner": false
                },
                {
                    pubkey: clearingHouse.wallet.publicKey, 
                    "isWritable": false,
                    "isSigner": true
                },
                {
                    pubkey: liquidatorAccountPublicKey,
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
            const txIx = new TransactionInstruction({
                data: clearingHouse.program.coder.instruction.encode('liquidate', []),
                programId: clearingHouse.program.programId,
                keys: keys.concat(remainingAccounts)
            });
            // console.log(txIx);
            // txIx.keys.forEach(k => console.log(k.pubkey.toBase58()))
            // console.log(regularTxIx);
            // regularTxIx.keys.forEach(k => console.log(k.pubkey.toBase58()))
            // process.exit()
            resolve(txIx)
        })
    })
}


enum Priority {
    'high',
    'medium',
    'low'
}

const getPrio = (user : User) => {
    return (user.marginRatio.lte(new BN(highPriorityMarginRatio)) ? Priority.high : (user.marginRatio.lte(new BN(mediumPriorityMarginRatio)) ? Priority.medium : Priority.low));
}

const sortUser = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map< Priority, PollingAccountSubscriber>, user: User, liquidatorAccountPublicKey: PublicKey) => {
    user.marginRatio = getMarginRatio(clearingHouse, user);
    let currentPrio = user.prio;
    let newPrio = getPrio(user);
    if (currentPrio !== newPrio) {
        if (currentPrio !== undefined)
        accountSubscriberBucketMap.get(currentPrio).removeAccountsToPoll(user.publicKey);

        userMap.set(user.publicKey, { ...user, prio: newPrio})

        accountSubscriberBucketMap.get(newPrio).addAccountToPoll(user.publicKey, 'user', user.publicKey, (data: UserAccount) => {
            // console.log('updated user', 'account data', user.publicKey)
            userMap.set(user.publicKey, { ...userMap.get(user.publicKey), accountData: data } as User);
            sortUser(clearingHouse, userMap, accountSubscriberBucketMap, userMap.get(user.publicKey), liquidatorAccountPublicKey);
        });

        accountSubscriberBucketMap.get(newPrio).addAccountToPoll(user.publicKey, 'userPositions', user.positions, (data: UserPositionsAccount) => {
            // console.log(data);
            // console.log('updated user', 'positions data', user.publicKey)
            const oldData = userMap.get(user.publicKey);
            const newData = { ...oldData, positionsAccountData: data } as User;
            newData.marginRatio = getMarginRatio(clearingHouse, newData);
            userMap.set(user.publicKey, newData);
            prepareUserLiquidationIX(clearingHouse, userMap, newData, liquidatorAccountPublicKey);
            sortUser(clearingHouse, userMap, accountSubscriberBucketMap, newData, liquidatorAccountPublicKey);
        });

    }
}

const sortUsers = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, liquidatorAccountPublicKey: PublicKey) => {
    [...userMap.values()].forEach(async user => sortUser(clearingHouse, userMap, accountSubscriberBucketMap, user, liquidatorAccountPublicKey));
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


//get all the users' account, positions

const setupUsers = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, users: Array<User>, tpuConnection: TpuConnection, liquidatorAccountPublicKey: PublicKey) => {
    let usersSetup = []

    usersSetup = chunkArray(await Promise.all(users.map(async (u, index) => {
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
                setTimeout(async () => {
                    //@ts-ignore
                    resolve(flatDeep(await Promise.all(request.map( async dataChunk => (await axios.post(tpuConnection._rpcEndpoint, dataChunk)).data )), Infinity))
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
            return clearingHouse.program.account['user'].coder.accounts.decode(
                // @ts-ignore
                clearingHouse.program.account['user']._idlAccount.name, 
                buffer
            ) as UserAccount
        })
        
        const mappedUserPositionAccounts = userPositionAccounts.result.value.map(p => {
            const raw: string = p.data[0];
            const dataType = p.data[1]
            const buffer = Buffer.from(raw, dataType);
            return clearingHouse.program.account[
                'userPositions'
            ].coder.accounts.decode(
                // @ts-ignore
                clearingHouse.program.account['userPositions']._idlAccount.name,
                buffer
            ) as UserPositionsAccount
        })

        Promise.all(usersSetup[x].map((u, i) => {
            let user = {
                ...u,
                accountData: mappedUserAccounts[i],
                positionsAccountData: mappedUserPositionAccounts[i]
            }
            user.marginRatio = getMarginRatio(clearingHouse, user);
            setTimeout(() => {
                prepareUserLiquidationIX(clearingHouse, userMap, user, liquidatorAccountPublicKey)
            }, 1000 * i)
            userMap.set(user.publicKey, user);
            sortUser(clearingHouse, userMap, accountSubscriberBucketMap, user, liquidatorAccountPublicKey)
        }))
    }
}



let usersToSetup = [];
let setupUsersTimeout = null
const setupUser = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, u : User, tpuConnection: TpuConnection, liquidatorAccountPublicKey: PublicKey) => {
    if (!usersToSetup.includes(u)) {
        usersToSetup.push(u);
    }
    clearTimeout(setupUsersTimeout)
    setupUsersTimeout = setTimeout(() => {
        console.log('setting up users');
        // const startTime = process.hrtime();
        setupUsers(clearingHouse, userMap, accountSubscriberBucketMap, usersToSetup, tpuConnection, liquidatorAccountPublicKey).then(() => {
            usersToSetup = [];
            // const endTime = process.hrtime(startTime);
            // console.log('took ' + endTime[0] * 1000  + ' ms');
            [...accountSubscriberBucketMap.keys()].forEach(key => accountSubscriberBucketMap.get(key).subscribe());
        });
    }, 2000)
}

// used for the funding table
interface MarketFunding {
    marketId: number,
    marketSymbol: string,
    ts: number,
    rate: string
}

const getFunding = (clearingHouse: ClearingHouse) => {
    // reset the funding rate map, keep memory low
    const fundingRateMap : Map<string, Array<MarketFunding>> = new Map<string, Array<MarketFunding>>();
    let fundingTable = [];
    const funding = clearingHouse.getFundingRateHistoryAccount().fundingRateRecords
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

    return fundingTable.map((lastFundingRate : MarketFunding) => {
        return {
            "Market": lastFundingRate.marketSymbol,
            "Funding Rate (APR)": lastFundingRate.rate
        }
    });

}


const print = async (clearingHouse: ClearingHouse, data : any, userAccount: PublicKey) => {
    const liquidatorMap = await updateLiquidatorMap(mapHistoryAccountToLiquidationsArray(clearingHouse.getLiquidationHistoryAccount()))
    const liquidationChart = getLiquidationChart(liquidatorMap, [userAccount.toBase58()])
    const liquidationTables = getLiquidatorProfitTables(liquidatorMap, [userAccount.toBase58()])
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
            }]), [getTable(getFunding(clearingHouse))], [...liquidationTables].map(t => getTable(t)), liquidationChart].flat().join("\n\n"))
}


const blacklistAuthority = ['5jdnNir8fdbQPjFvUxNJsXEKL25Z5FnzGv3aWGDVSwZr']

const getUsers = (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, tpuConnection: TpuConnection, liquidatorAccountPublicKey: PublicKey) => {
    if (fs.pathExistsSync('./storage/programUserAccounts')) {
        let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
        (JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string, positions: string }>).forEach(async user => {
            if (!userMap.has(user.publicKey) && !blacklistAuthority.includes(user.authority))
                setupUser(clearingHouse, userMap, accountSubscriberBucketMap, user as User, tpuConnection, liquidatorAccountPublicKey)
        })
    } else {
        console.error('storage/programUserAccounts doesn\'t exist.... if the file is there and isn\'t empty, just start the bot again!')
        console.error('try using "npm run getUsers" before running the bot')
        process.exit();
    }
}

const main = async () => {
    const mainnetRPC = new Connection('https://api.mainnet-beta.solana.com', { commitment: 'processed' });
    const rpcPool = new Connection('https://free.rpcpool.com', { commitment: 'processed' } );
    const tpuConnection = await TpuConnection.load(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 60 * 1000 } as ConnectionConfig );
    const clearingHouse = _.createClearingHouse(tpuConnection);
    await clearingHouse.subscribe(['liquidationHistoryAccount', "fundingRateHistoryAccount"]);
    const liquidatorAccountPublicKey = await clearingHouse.getUserAccountPublicKey();

    const accountSubscriberBucketMap : Map<Priority, PollingAccountSubscriber> = new Map<Priority, PollingAccountSubscriber>();
    const userMap : Map<string, User> = new Map<string, User>();

    // poll low priority accounts every 5 minutes
    const lowPriorityBucket = new PollingAccountSubscriber('low prio', clearingHouse.program, 0, 60 * 1000);
    accountSubscriberBucketMap.set(Priority.low, lowPriorityBucket)

    // poll medium priority accounts every minute
    const mediumPriorityBucket = new PollingAccountSubscriber('medium prio',clearingHouse.program, 0, 30 * 1000);
    accountSubscriberBucketMap.set(Priority.medium, mediumPriorityBucket)

    const highPriorityBucket = new PollingAccountSubscriber('high prio', clearingHouse.program, 0, 1000);
    accountSubscriberBucketMap.set(Priority.high, highPriorityBucket)
    
    getUsers(clearingHouse, userMap, accountSubscriberBucketMap, tpuConnection, liquidatorAccountPublicKey)

    
    setTimeout(() => {
        setInterval(() => {
            getUsers(clearingHouse, userMap, accountSubscriberBucketMap, tpuConnection, liquidatorAccountPublicKey)
        }, 60 * 1000)
    }, 30 * 1000)
    

    setInterval(() => {
        sortUsers(clearingHouse, userMap, accountSubscriberBucketMap, liquidatorAccountPublicKey);
    }, (60 * 1000));

    



    // prepare variables for liquidation loop
    let intervalCount = 0
    let numUsersChecked = new Array<number>();
    let checkTime = new Array<number>();

    let blockhashIndex = 0;

    const getBlockhash = async () : Promise<string> => {
        let blockhash = null;
        switch(blockhashIndex) {
            case 0:
                blockhash = (await axios.post('https://demo.theindex.io', {"jsonrpc":"2.0","id":1, "method":"getRecentBlockhash", "params": [ { commitment: 'processed'}] })).data.result.value.blockhash;
                break;
            case 1:
                blockhash = (await clearingHouse.connection.getRecentBlockhash()).blockhash
                break;
            case 2:
                blockhash = (await mainnetRPC.getRecentBlockhash()).blockhash
                break;
            case 3:
                blockhash = (await rpcPool.getRecentBlockhash()).blockhash
                break;
        }
        blockhashIndex++;
        if (blockhashIndex > 3) {
            blockhashIndex = 0;
        }
        return blockhash
    }

    // get blockhashes of multiple rpcs every second
    setInterval(async () => {
        try {
            recentBlockhashes = new Set<string>([await getBlockhash()]);
        } catch (error) {
            console.error(error);
        }
    }, 500)

    // check the highPriorityBucket every x seconds
    setInterval(() => {
        checkBucket(clearingHouse, userMap, highPriorityBucket, tpuConnection, numUsersChecked, checkTime, liquidatorAccountPublicKey)
        intervalCount++;
    }, highPrioCheckUsersEveryMS);


    // print the memory usage every 5 seconds
    setInterval(() => {
        // console.clear();
        console.log(`total mem usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`)
        // console.log(`low: ${lowPriorityBucket.getAllKeys().length}, medium: ${mediumPriorityBucket.getAllKeys().length}, high: ${highPriorityBucket.getAllKeys().length}`)
    }, 10 * 1000)


    // print out the tables every x minutes
    setInterval(() => {
        const margin = [...userMap.values()].map(u => u.marginRatio.toNumber())
        const data = {
            userCount: userMap.size,
            prio: {
                high: highPriorityBucket.getAllKeys().length,
                medium: mediumPriorityBucket.getAllKeys().length,
                low: lowPriorityBucket.getAllKeys().length
            },
            // intervalCount: intervalCount,
            // checked: numUsersChecked,
            margin: Math.min(...margin) / 100,
            // time: checkTime.reduce((a, b) => a+b, 0).toFixed(2) 
        }

        print(clearingHouse, data, liquidatorAccountPublicKey).then(() => {
            intervalCount = 0
            numUsersChecked = new Array<number>();
            checkTime = new Array<number>();
        })

    }, 60 * 1000 * workerLoopTimeInMinutes);

};

process.on('uncaughtException', () => {

})

process.on('unhandledRejection', () => {
    
})

main();

