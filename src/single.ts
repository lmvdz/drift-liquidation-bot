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
    MARGIN_PRECISION,
    MarginCategory,
    AMM_RESERVE_PRECISION,
    PositionDirection,
    calculateTradeSlippage,
    calculateNewMarketAfterTrade,
    QUOTE_PRECISION,
    BASE_PRECISION
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
const highPrioCheckUsersEveryMS = 100

const liquidateEveryMS = 5

// how many liquidation tx can be sent per minute (counts tpc and tpu as two seperate tx's)
const txLimitPerMinute = 2;


// unused
// the slippage of partial liquidation as a percentage --- 12 = 12% = 0.12 => when margin ratio reaches 625 * (1 + 0.12) = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 2

const slipLiq = (marginRequirement, percent) => new BN(marginRequirement.toNumber() * (1 + (percent/100)));

// the liquidation distance determines which priority bucket the user will be a part of.
// liquidation distance is totalCollateral / partialMarginRequirement
const highPriorityLiquidationDistance = 5
const mediumPriorityLiquidationDistance = 10

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
    prio: Priority,
    liquidationMath: LiquidationMath
    
}

type MarketBaseAssetAmounts = {
    [key: number]: BN
}

type MarketMarginRequirement = {
    [key: number]: BN
}

type MarketUnrealizedPnL = {
    [key: number]: BN
}

type MarketLiquidationPrice = {
    [key: number]: BN
}

interface MarketFunding {
    marketId: number,
    marketSymbol: string,
    ts: number,
    rate: string
}

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
    marketBaseAssetAmount: MarketBaseAssetAmounts
    marketMarginRequirement: MarketMarginRequirement
    marketUnrealizedPnL: MarketUnrealizedPnL
    marketLiquidationPrice: MarketLiquidationPrice

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



class Liquidator {
    intervals: Array<NodeJS.Timer> = [];
    usersToSetup: Array<User> = [];
    setupUsersTimeout: NodeJS.Timer = null
    intervalCount = 0
    numUsersChecked = new Array<number>();
    checkTime = new Array<number>();
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
    liquidationTxSent: number
    

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
            console.error(error);
        });

        // this needs to update as fast a possible to get the most up to date margin ratio.
        this.clearingHouseSubscriber.addProgram('markets', this.clearingHouseData.markets, this.clearingHouse.program as any, (data: MarketsAccount) => {
            // console.log('updated clearingHouse markets');
            this.clearingHouseData.marketsAccount = data;
        }, (error: any) => {
            console.error(error);
        });

        this.clearingHouseSubscriber.addProgram('liquidationHistory', this.clearingHouseData.liquidationHistory, this.clearingHouse.program as any,  (data: LiquidationHistoryAccount) => {
            // console.log('updated clearingHouse liquidationHistory');
            this.clearingHouseData.liquidationHistoryAccount = data;
        }, (error: any) => {
            console.error(error);
        });

        this.clearingHouseSubscriber.addProgram('fundingRateHistory', this.clearingHouseData.fundingRateHistory, this.clearingHouse.program as any,  (data: FundingRateHistoryAccount) => {
            // console.log('updated clearingHouse fundingRate');
            this.clearingHouseData.fundingRateHistoryAccount = data;
        }, (error: any) => { 
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



        this.intervals.push(setInterval(async function() {

            const liquidator = (this as Liquidator);

            liquidator.liquidationGroup.forEach(async liquidatee => {
                let user = liquidator.userMap.get(liquidatee);

                if (user === undefined) {
                    liquidator.liquidationGroup.delete(liquidatee);  
                } else {
                    user.liquidationMath = this.getLiquidationMath(user)

                    this.userMap.set(user.publicKey, user);

                    if (user.liquidationMath.totalCollateral.gt(slipLiq(user.liquidationMath.partialMarginRequirement, partialLiquidationSlippage))) {
                        liquidator.liquidationGroup.delete(liquidatee);
                    } else {
                        liquidator.liquidate(user);
                    }
                }
            });

        }.bind(this), liquidateEveryMS));


        // reset the number of tx's sent per minute
        this.intervals.push(setInterval(async function() {

            this.liquidationTxSent = 0;

        }.bind(this), 60 * 1000 * txLimitPerMinute));


        // check the highPriorityBucket every x seconds
        this.intervals.push(setInterval(async function() {

            const liquidator = (this as Liquidator);

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
            const margin = [...liquidator.userMap.values()].map(u => u.liquidationMath.marginRatio.toNumber())
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

    getEmptyPosition(marketIndex: BN) {
        return {
			baseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			openOrders: ZERO,
		};
    }

    getMaxLeverage(
		marketIndex: BN,
		category: MarginCategory = 'Initial'
	): BN {
		const market = this.clearingHouseData.marketsAccount.markets[marketIndex.toNumber()];
		let marginRatioCategory: number;

		switch (category) {
			case 'Initial':
				marginRatioCategory = market.marginRatioInitial;
				break;
			case 'Maintenance':
				marginRatioCategory = market.marginRatioMaintenance;
				break;
			case 'Partial':
				marginRatioCategory = market.marginRatioPartial;
				break;
			default:
				marginRatioCategory = market.marginRatioInitial;
				break;
		}
		const maxLeverage = TEN_THOUSAND.mul(TEN_THOUSAND).div(
			new BN(marginRatioCategory)
		);
		return maxLeverage;
	}
    liquidationPrice(
        user: User,
        liquidationMath: LiquidationMath,
        clearingHouseData: ClearingHouseData,
		marketPosition: Pick<UserPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO,
		partial = false
	): BN {
		// solves formula for example canBeLiquidated below

		/* example: assume BTC price is $40k (examine 10% up/down)

        if 10k deposit and levered 10x short BTC => BTC up $400 means:
        1. higher base_asset_value (+$4k)
        2. lower collateral (-$4k)
        3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

        for 10x long, BTC down $400:
        3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const totalCollateral = liquidationMath.totalCollateral;

		// calculate the total position value ignoring any value from the target market of the trade
		const totalPositionValueExcludingTargetMarket = liquidationMath.totalPositionValue.sub(liquidationMath.marketBaseAssetAmount[marketPosition.marketIndex.toNumber()]);

		const currentMarketPosition =
            user.positionsAccountData.positions.find(p => p.marketIndex.eq(marketPosition.marketIndex)) || this.getEmptyPosition(marketPosition.marketIndex);

		const currentMarketPositionBaseSize = currentMarketPosition.baseAssetAmount;

		const proposedBaseAssetAmount = currentMarketPositionBaseSize.add(
			positionBaseSizeChange
		);

		// calculate position for current market after trade
		const proposedMarketPosition: UserPosition = {
			marketIndex: marketPosition.marketIndex,
			baseAssetAmount: proposedBaseAssetAmount,
			lastCumulativeFundingRate:
				currentMarketPosition.lastCumulativeFundingRate,
			quoteAssetAmount: new BN(0),
			openOrders: new BN(0),
		};

		if (proposedBaseAssetAmount.eq(ZERO)) return new BN(-1);

		const market = clearingHouseData.marketsAccount.markets[proposedMarketPosition.marketIndex.toNumber()]

		const proposedMarketPositionValue = calculateBaseAssetValue(
			market,
			proposedMarketPosition
		);

		// total position value after trade
		const totalPositionValueAfterTrade =
			totalPositionValueExcludingTargetMarket.add(proposedMarketPositionValue);

		const marginRequirementExcludingTargetMarket =
			user.positionsAccountData.positions.reduce(
				(totalMarginRequirement, position) => {
					if (!position.marketIndex.eq(marketPosition.marketIndex)) {
						const market = this.clearingHouseData.marketsAccount.markets[position.marketIndex.toNumber()];
						const positionValue = calculateBaseAssetValue(market, position);
						const marketMarginRequirement = positionValue
							.mul(
								partial
									? new BN(market.marginRatioPartial)
									: new BN(market.marginRatioMaintenance)
							)
							.div(MARGIN_PRECISION);
						totalMarginRequirement = totalMarginRequirement.add(
							marketMarginRequirement
						);
					}
					return totalMarginRequirement;
				},
				ZERO
			);

		const freeCollateralExcludingTargetMarket = totalCollateral.sub(
			marginRequirementExcludingTargetMarket
		);

		// if the position value after the trade is less than free collateral, there is no liq price
		if (
			totalPositionValueAfterTrade.lte(freeCollateralExcludingTargetMarket) &&
			proposedMarketPosition.baseAssetAmount.abs().gt(ZERO)
		) {
			return new BN(-1);
		}

		const marginRequirementAfterTrade =
			marginRequirementExcludingTargetMarket.add(
				proposedMarketPositionValue
					.mul(
						partial
							? new BN(market.marginRatioPartial)
							: new BN(market.marginRatioMaintenance)
					)
					.div(MARGIN_PRECISION)
			);
		const freeCollateralAfterTrade = totalCollateral.sub(
			marginRequirementAfterTrade
		);

		const marketMaxLeverage = partial
			? this.getMaxLeverage(proposedMarketPosition.marketIndex, 'Partial')
			: this.getMaxLeverage(proposedMarketPosition.marketIndex, 'Maintenance');

		let priceDelta;
		if (proposedBaseAssetAmount.lt(ZERO)) {
			priceDelta = freeCollateralAfterTrade
				.mul(marketMaxLeverage) // precision is TEN_THOUSAND
				.div(marketMaxLeverage.add(TEN_THOUSAND))
				.mul(PRICE_TO_QUOTE_PRECISION)
				.mul(AMM_RESERVE_PRECISION)
				.div(proposedBaseAssetAmount);
		} else {
			priceDelta = freeCollateralAfterTrade
				.mul(marketMaxLeverage) // precision is TEN_THOUSAND
				.div(marketMaxLeverage.sub(TEN_THOUSAND))
				.mul(PRICE_TO_QUOTE_PRECISION)
				.mul(AMM_RESERVE_PRECISION)
				.div(proposedBaseAssetAmount);
		}

		let markPriceAfterTrade;
		if (positionBaseSizeChange.eq(ZERO)) {
			markPriceAfterTrade = calculateMarkPrice(
				this.clearingHouseData.marketsAccount.markets[marketPosition.marketIndex.toNumber()]
			);
		} else {
			const direction = positionBaseSizeChange.gt(ZERO)
				? PositionDirection.LONG
				: PositionDirection.SHORT;
			markPriceAfterTrade = calculateTradeSlippage(
				direction,
				positionBaseSizeChange.abs(),
				this.clearingHouseData.marketsAccount.markets[marketPosition.marketIndex.toNumber()],
				'base'
			)[3]; // newPrice after swap
		}

		if (priceDelta.gt(markPriceAfterTrade)) {
			return new BN(-1);
		}

		return markPriceAfterTrade.sub(priceDelta);
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
                user.liquidationMath = this.getLiquidationMath(user)
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
        user.liquidationMath = this.getLiquidationMath(user)
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
                newData.liquidationMath = this.getLiquidationMath(newData);
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
        if (!user.liquidationMath.partialMarginRequirement.eq(ZERO)) {
            
            const liqDistance = user.liquidationMath.totalCollateral.toNumber() / user.liquidationMath.partialMarginRequirement.toNumber();

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

        const liquidationMath = {
            totalCollateral: ZERO, 
            marginRatio: BN_MAX, 
            totalPositionValue: ZERO, 
            unrealizedPNL: ZERO, 
            partialMarginRequirement: ZERO, 
            marketBaseAssetAmount: {} as MarketBaseAssetAmounts, 
            marketMarginRequirement: {} as MarketMarginRequirement, 
            marketUnrealizedPnL: {} as MarketUnrealizedPnL,
            marketLiquidationPrice: {} as MarketLiquidationPrice
        } as LiquidationMath


        if (positions.length === 0) {
            return liquidationMath;
        }
    
        
        positions.forEach(async position => {
            const market = this.clearingHouseData.marketsAccount.markets[position.marketIndex.toNumber()];
            if (market !== undefined) {
                // store in per market object
                liquidationMath.marketBaseAssetAmount[position.marketIndex.toNumber()] = calculateBaseAssetValue(market, position);
                // add to total
                liquidationMath.totalPositionValue = liquidationMath.totalPositionValue.add(liquidationMath.marketBaseAssetAmount[position.marketIndex.toNumber()]);

                // store in per market object
                liquidationMath.marketMarginRequirement[position.marketIndex.toNumber()] = liquidationMath.marketBaseAssetAmount[position.marketIndex.toNumber()].mul(new BN(market.marginRatioPartial)).div(MARGIN_PRECISION);
                // add to total
                liquidationMath.partialMarginRequirement = liquidationMath.partialMarginRequirement.add(liquidationMath.marketMarginRequirement[position.marketIndex.toNumber()]);
                

                // store in per market object
                liquidationMath.marketUnrealizedPnL[position.marketIndex.toNumber()] = this.calculatePositionPNL(market, position, liquidationMath.marketBaseAssetAmount[position.marketIndex.toNumber()], true)
                // add to total
                liquidationMath.unrealizedPNL = liquidationMath.unrealizedPNL.add(liquidationMath.marketUnrealizedPnL[position.marketIndex.toNumber()]);

                // store in per market object
                liquidationMath.marketLiquidationPrice[position.marketIndex.toNumber()] = this.liquidationPrice(user, liquidationMath, this.clearingHouseData, position);

            } else {
                console.log(user.accountData.positions.toBase58(), user.publicKey);
                console.log(market, position.marketIndex.toString());
                console.log('market undefined', market);
            }
            
        })
    
        // unrealizedPnLMap.set(user.publicKey, unrealizedPNL.toString());
    
        if (liquidationMath.totalPositionValue.eq(ZERO)) {
            return liquidationMath;
        }

        liquidationMath.totalCollateral = (
            user.accountData.collateral.add(liquidationMath.unrealizedPNL) ??
            ZERO
        );

        liquidationMath.marginRatio = liquidationMath.totalCollateral.mul(TEN_THOUSAND).div(liquidationMath.totalPositionValue);

        return liquidationMath ;
    }

    async checkForLiquidation (pub : string) {    
        let user = this.userMap.get(pub);
        
        if (user !== undefined) {
            if (!this.liquidationGroup.has(pub)) {
                user.liquidationMath = this.getLiquidationMath(user)
                const slip = slipLiq(user.liquidationMath.partialMarginRequirement, partialLiquidationSlippage);
                // console.log(pub)
                // Object.keys(user.liquidationMath.marketLiquidationPrice).forEach(key => {
                //     console.log(Markets[Number(key)].symbol, user.positionsAccountData.positions.find(position => position.marketIndex.toNumber() === Number(key)).baseAssetAmount.div(BASE_PRECISION).toNumber(), (user.liquidationMath.marketLiquidationPrice[key] as BN).div(QUOTE_PRECISION).toNumber());
                // });
                // console.log(user.liquidationMath.totalCollateral.toNumber(), slip.toNumber())
                // console.log('');
                
                this.userMap.set(user.publicKey, user);
                if (user.liquidationMath.totalCollateral.lt(slip)) {
                    try {
                        this.liquidationGroup.add(pub);
                        this.liquidate(user);
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
        } else {
            this.userMap.delete(pub);
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
    async liquidate(user: User) : Promise<void> {

        if (this.liquidationTxSent > txLimitPerMinute) {
            return;
        }

        let instruction = user.liquidationInstruction
        if (instruction === undefined) {
            instruction = this.prepareUserLiquidationIX(user)
        }
        try {
            // console.log('trying to liquiate: ' + user.authority, user.liquidationMath.marginRatio.toNumber(), user.liquidationMath.totalCollateral.toNumber(), user.liquidationMath.partialMarginRequirement.toNumber(), new Date(Date.now()));
            let tx = this.wrapInTx(instruction);
            tx.recentBlockhash = (await this.tpuConnection.getRecentBlockhash()).blockhash;
            tx.feePayer = this.clearingHouse.wallet.publicKey;
            tx = await this.clearingHouse.wallet.signTransaction(tx);

            // first send to rpc
            try {
                this.tpuConnection.tpuClient.connection.sendRawTransaction(tx.serialize());
                this.liquidationTxSent++;
            } catch (error) {
                this.prepareUserLiquidationIX(user);
            }

            // then to tpu
            try {
                this.tpuConnection.tpuClient.sendRawTransaction(tx.serialize()); 
                this.liquidationTxSent++;
            } catch {
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