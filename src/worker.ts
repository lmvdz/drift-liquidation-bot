import { default as _ } from './clearingHouse.js'

// solana web3
import {PublicKey, TransactionResponse } from '@solana/web3.js'

// used for drift sdk
import {
    BN_MAX,
    calculateBaseAssetValue,
    calculatePositionFundingPNL,
    Market,
    Markets,
    ClearingHouseUser,
    PARTIAL_LIQUIDATION_RATIO,
    PositionDirection,
    PRICE_TO_QUOTE_PRECISION,
    TEN_THOUSAND,
    UserAccount,
    UserPosition,
    ZERO,
} from '@drift-labs/sdk';



import BN from 'bn.js'

// used to store the data, uses the same api calls as window.localStorage but works with nodejs
import { LocalStorage } from 'node-localstorage'
import { IPC_UserAccount, IPC_UserPosition, convertUserPositionFromIPC, convertUserAccountFromIPC } from './ipcInterface.js';
const localStorage = new LocalStorage('./storage');

const args = process.argv.slice(2);

const uuid = args[0]


// CONFIG THE LOOP TAKEN FROM THE ARGUMENTS SUPPLIED FROM INDEX.TS

// worker loop time in minutes
const workerLoopTimeInMinutes = parseFloat(args[1])
// update the liquidation distance of all users every X minutes, must be lower than the liquidationLoopTimeInMinutes otherwise won't be called
const updateLiquidationDistanceInMinutes = parseFloat(args[2])
// check users for liquidation every X milliseconds
const checkUsersInMS = parseFloat(args[3])
// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 )))) + (margin_ratio % (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 ))))
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
// adding on the slipage of 4 % will make the partial_liquidation_ratio 650, so a value of 10 will mean users with margin_ratios less than 6500
const minLiquidationDistance = parseFloat(args[4])

// the slippage of partial liquidation as a percentage
const partialLiquidationSlippage = parseFloat(args[5])

interface User {
    account: UserAccount,
    positions: Array<UserPosition>,
    eventListeners: Array<EventListener>
}
// setup bot state
const users : Map<string, User> = new Map<string, User>();
const usersLiquidationDistance : Map<string, number> =  new Map<string, number>();
// dont sort, slows down the bot, filtering should be good enough
// const usersSortedByLiquidationDistance  = () : Array<string>  => {
//     const publicKeys = ([...usersLiquidationDistance].map(e => { return e[0]; }) as Array<string>);
//     publicKeys.sort((a, b) => { 
//         return usersLiquidationDistance.get(a)! - usersLiquidationDistance.get(b)!
//     })
//     return publicKeys
// }

const getLiqTransactionProfit = (tx:string) : Promise<number> => {
    return new Promise((resolve, reject) => {
        _.genesysgoConnection.getTransaction(tx).then((transaction : TransactionResponse) => {
            let clearingHouseUserPreTokenBalance : number = parseFloat(transaction.meta.preTokenBalances[0].uiTokenAmount.uiAmountString)
            let clearingHouseUserPostTokenBalance : number = parseFloat(transaction.meta.postTokenBalances[0].uiTokenAmount.uiAmountString)
            let balanceChange = clearingHouseUserPreTokenBalance - clearingHouseUserPostTokenBalance;
            resolve(balanceChange)
        }).catch(error => {
            reject(error)
        })
    })
    
}
const invert  = p  => new Promise((res, rej) => p.then(rej, res));
const firstOf = ps => invert(Promise.all(ps.map(invert)));


// liquidation helper function
const liq = (pub:PublicKey) : Promise<void> => {
    return new Promise((resolve, reject) => {
        firstOf([_.rpcPoolClearingHouse.liquidate(pub), _.genesysgoClearingHouse.liquidate(pub)]).then((tx : string) => {
            getLiqTransactionProfit(tx).then((balanceChange : number) => {
                let liquidationStorage = localStorage.getItem('liquidations');
                if (liquidationStorage === undefined || liquidationStorage == null) {
                    liquidationStorage = []
                } else {
                    liquidationStorage = JSON.parse(liquidationStorage)
                }
                
                if (!liquidationStorage.some(liquidation => liquidation.tx === tx)) {
                    liquidationStorage.push({ pub: pub.toBase58(), tx, balanceChange })
                }

                localStorage.setItem('liquidations', JSON.stringify(liquidationStorage))
                // console.log(`${new Date()} - Liquidated user: ${user} Tx: ${tx} --- +${balanceChange.toFixed(2)} USDC`)
                resolve()
            })
        }).catch(error => {
            // if (error.message.includes('custom program error: 0x130'))
                // console.log(`Frontrun failed, sufficient collateral -- ${distance} -- ${marginRatio.toNumber()} -- ${slipLiq}`)
            resolve()
        });
    })
}

// if the margin ratio is less than the liquidation ratio just return 1 to move it to the front of the liquidation distance array
// divide the margin ratio by the partial liquidation ratio to get the distance to liquidation for the user
// use div and mod to get the decimal values

const partialLiquidationWithSlippage = () => {
    return PARTIAL_LIQUIDATION_RATIO.mul(new BN((1 + (partialLiquidationSlippage/100))))
}

const slipLiq = partialLiquidationWithSlippage()

const calcDistanceToLiq = (marginRatio) => {
    if (marginRatio.eq(BN_MAX)) {
        return -1
    } else if (marginRatio.lte(slipLiq)) {
        return 1
    } else {
        return marginRatio.div(slipLiq).add(marginRatio.mod(slipLiq)).toNumber()
    }
    
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

	const directionToClose = marketPosition.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	let pnlAssetAmount;

	switch (directionToClose) {
		case PositionDirection.SHORT:
			pnlAssetAmount = baseAssetValue.sub(marketPosition.quoteAssetAmount);
			break;

		case PositionDirection.LONG:
			pnlAssetAmount = marketPosition.quoteAssetAmount.sub(baseAssetValue);
			break;
	}

	if (withFunding) {
		const fundingRatePnL = calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION);

		pnlAssetAmount = pnlAssetAmount.add(fundingRatePnL);
	}

	return pnlAssetAmount;
}

const getMarginRatio = (pub: string) => {
    const user = users.get(pub)
    const positions = user.positions;

    if (positions.length === 0) {
        return BN_MAX;
    }

    let totalPositionValue = ZERO, unrealizedPNL = ZERO

    positions.forEach(position => {
        const market = _.genesysgoClearingHouse.getMarket(position.marketIndex);
        const baseAssetAmountValue = calculateBaseAssetValue(market, position);
        const pnl = calculatePositionPNL(market, position, baseAssetAmountValue, true)
        totalPositionValue = totalPositionValue.add(baseAssetAmountValue)
        unrealizedPNL = unrealizedPNL.add(pnl)
    })

    if (totalPositionValue.eq(ZERO)) {
        return BN_MAX;
    }

    let marginRatio = (
        user.account.collateral.add(unrealizedPNL) ??
        new BN(0)
    ).mul(TEN_THOUSAND).div(totalPositionValue);
    return marginRatio;
}





// get all the users from the program and the storage
// add the new users to the storage
// maybe one day only request users which are not in storage


const filtered = () => [...usersLiquidationDistance].filter(([, distance]) => { 
    return distance > 0 && distance < minLiquidationDistance
});

const prioSet : Set<string> = new Set();

const checkUserPriorityLoop = (pub) => {
    if (prioSet.has(pub)) {
        ;( async () => {
            liq(pub)
            checkUserPriorityLoop(pub)
        })();
    }
}

const checkUser = (pub) : Promise<number> => {
    return new Promise((resolve) => {
        const marginRatio = getMarginRatio(pub)
        const closeToLiquidation = marginRatio.lte(new BN(slipLiq))
        usersLiquidationDistance.set(pub, calcDistanceToLiq(marginRatio))
        if (closeToLiquidation) {
            if (!prioSet.has(pub)) {
                prioSet.add(pub);
                (async () => {
                    checkUserPriorityLoop(pub)
                })
            } else if (!closeToLiquidation) {
                prioSet.delete(pub)
            }
        }
        resolve(marginRatio.div(new BN(100)).toNumber())
    })
    
}

const mapFilteredToLiquidationCheck = () : Array<Promise<number>> => {
    return filtered().map(([publicKey,]) : Promise<number> => { 
        return new Promise((innerResolve) => {
            checkUser(publicKey).then(margin => innerResolve(margin))
        })
    })
}

// based on liquidation distance check users for liquidation
const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number], averageMarginRatio: number }> => {
    return new Promise(resolve => {
        var hrstart = process.hrtime();
        const filtered = mapFilteredToLiquidationCheck()
        Promise.all(filtered).then((promises) => {
            resolve({numOfUsersChecked: filtered.length, time: process.hrtime(hrstart), averageMarginRatio: promises.reduce((a : number, b : number) => a + b, 0) })
        })
    })
}


const updateUserLiquidationDistances = () => {
    Promise.all([...users.keys()].map(publicKey => new Promise(resolve => resolve(usersLiquidationDistance.set(publicKey, calcDistanceToLiq(getMarginRatio(publicKey)))))))
}


// prepare variables for liquidation loop
let intervalCount = 0
let numUsersChecked = new Array<number>();
let totalTime = new Array<number>();
let avgMarginRatio = new Array<number>();

// liquidation bot, where the magic happens
const startWorker = () => {
    _.genesysgoClearingHouse.subscribe().then(() => {
        // dont need to call this if we're checking every user
        // update all users liquidation distance every x minutes
        (async () => {
            setInterval(() => {
                updateUserLiquidationDistances();
            }, 60 * 1000 * updateLiquidationDistanceInMinutes)
            setInterval(() => {
                checkUsersForLiquidation().then(({ numOfUsersChecked, time, averageMarginRatio }) => {
                    intervalCount++
                    numUsersChecked.push(Number(numOfUsersChecked))
                    if (averageMarginRatio > 0 && averageMarginRatio < 1000) {
                        avgMarginRatio.push(Number(averageMarginRatio))  
                    }
                    totalTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
                })
            }, checkUsersInMS * 10)
            setInterval(() => {
                const data = {
                    total: '',
                    intervalCount,
                    workerLoopTimeInMinutes: workerLoopTimeInMinutes,
                    checked: {
                        min: Math.min(...numUsersChecked),
                        avg: (numUsersChecked.reduce((a, b) => a+b, 0)/numUsersChecked.length).toFixed(2),
                        max: Math.max(...numUsersChecked),
                        total: parseInt((numUsersChecked.reduce((a, b) => a+b, 0))+""),
                    },
                    time: {
                        min: Math.min(...totalTime).toFixed(2),
                        avg: (totalTime.reduce((a, b) => a+b, 0)/totalTime.length).toFixed(2),
                        max: Math.max(...totalTime).toFixed(2),
                        total: (totalTime.reduce((a, b) => a+b, 0)).toFixed(2),
                    },
                    margin: {
                        min: Math.min(...avgMarginRatio),
                        avg: ((avgMarginRatio.reduce((a, b) => a+b, 0)/avgMarginRatio.length)).toFixed(2),
                        max: Math.max(...avgMarginRatio)
                    }
                }
                const x = {
                    worker: uuid,
                    data: {
                        userCount: users.size,
                        intervalCount: intervalCount,
                        usersChecked: data.checked.max,
                        totalTime:  data.time.total,
                        // minMargin: data.margin.min + ' ' + data.margin.avg + ' ' + data.margin.max,
                        // slipLiq: (slipLiq/100).toFixed(4),
                        avgCheckMsPerUser: ( parseFloat(data.time.total) / (intervalCount *  (users.size)) ).toFixed(6)
                    }
                }
                // send data to main process
                console.log(JSON.stringify(x))
            
                const liqStorage = localStorage.getItem('liquidations');
                
                if (liqStorage !== undefined && liqStorage !== null) {
                    data.total = (JSON.parse(liqStorage) as Array<{ pub: string, tx: string, balanceChange: number }>).map((liq : { pub: string, tx: string, balanceChange: number } ) => liq.balanceChange).reduce((a : number, b : number) => a + b, 0).toFixed(2)
                }
            
                let workerStorage = localStorage.getItem('worker-'+uuid)
            
                if (workerStorage !== undefined && workerStorage !== null) {
                    workerStorage = JSON.parse(workerStorage)
                    workerStorage.push(data)
                    localStorage.setItem('worker-'+uuid, JSON.stringify(workerStorage))
                }
            
                intervalCount = 0
                numUsersChecked = new Array<number>();
                totalTime = new Array<number>();
                avgMarginRatio = new Array<number>();
            }, 60 * 1000 * workerLoopTimeInMinutes)
        })();
    }).catch(error => {
        console.error(error);
    })
    
}


const processMessage = (data : MessageData) => {
    const user = users.get(data.pub) ?? { positions: [] as Array<UserPosition>, account: {} as UserAccount } as User
    if (data.userPositionArray.length > 0) {
        user.positions = data.userPositionArray.map(convertUserPositionFromIPC);
        if (data.dataSource === 'userPositionsData') {
            usersLiquidationDistance.set(data.pub, calcDistanceToLiq(getMarginRatio(data.pub)));
        }
    }
    if (data.userAccount !== null) {
        user.account = convertUserAccountFromIPC(data.userAccount)
        if (data.dataSource === 'userAccountData') {
            usersLiquidationDistance.set(data.pub, calcDistanceToLiq(getMarginRatio(data.pub)));
        }
    }
    // console.log(dataSource, JSON.stringify(user))
    users.set(data.pub, user);
    if (data.dataSource === 'preExisting') {
        updateUserLiquidationDistances()
    }
}

interface MessageData {
    dataSource: string,
    pub: string,
    userPositionArray?: Array<IPC_UserPosition>
    userAccount?: IPC_UserAccount,
    market?: BN
}

process.on('message', (data : MessageData) => {
    processMessage(data)
})

startWorker()
