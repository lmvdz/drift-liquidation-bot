import { default as _ } from './clearingHouse.js'

// solana web3
import {PublicKey, TransactionResponse } from '@solana/web3.js'

// used for drift sdk
import {
    calculateBaseAssetValue,
    ClearingHouseUser, 
    PARTIAL_LIQUIDATION_RATIO,
    UserPosition,
    ZERO,
} from '@drift-labs/sdk';



import BN from 'bn.js'

// used to store the data, uses the same api calls as window.localStorage but works with nodejs
import { LocalStorage } from 'node-localstorage'
const localStorage = new LocalStorage('./storage');

const args = process.argv.slice(2);

const uuid = args[0]


// CONFIG THE LOOP TAKEN FROM THE ARGUMENTS SUPPLIED FROM INDEX.TS

// how many minutes before new users will be loaded from storage
const userUpdateInMinutes = parseFloat(args[1])
// worker loop time in minutes
const workerLoopTimeInMinutes = parseFloat(args[2])
// update the liquidation distance of all users every X minutes, must be lower than the liquidationLoopTimeInMinutes otherwise won't be called
const updateLiquidationDistanceInMinutes = parseFloat(args[3])
// check users for liquidation every X milliseconds
const checkUsersInMS = parseFloat(args[4])
// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 )))) + (margin_ratio % (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 ))))
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
// adding on the slipage of 4 % will make the partial_liquidation_ratio 650, so a value of 10 will mean users with margin_ratios less than 6500
const minLiquidationDistance = parseFloat(args[5])

// the slippage of partial liquidation as a percentage
const partialLiquidationSlippage = parseFloat(args[6])

// setup bot state
const userPositions : Map<string, Array<UserPosition>> = new Map<string, Array<UserPosition>>();
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
        _.mainnetConnection.getTransaction(tx).then((transaction : TransactionResponse) => {
            let clearingHouseUserPreTokenBalance : number = parseFloat(transaction.meta.preTokenBalances[0].uiTokenAmount.uiAmountString)
            let clearingHouseUserPostTokenBalance : number = parseFloat(transaction.meta.postTokenBalances[0].uiTokenAmount.uiAmountString)
            let balanceChange = clearingHouseUserPreTokenBalance - clearingHouseUserPostTokenBalance;
            resolve(balanceChange)
        }).catch(error => {
            reject(error)
        })
    })
    
}

// liquidation helper function
const liq = (pub:PublicKey, user:string) => {
    _.clearingHouse.liquidate(pub).then((tx) => {
        getLiqTransactionProfit(tx).then((balanceChange : number) => {
            let liquidationStorage = JSON.parse(localStorage.getItem('liquidations'))
            if (!liquidationStorage.some(liquidation => liquidation.tx === tx)) {
                liquidationStorage.push({ pub: pub.toBase58(), tx, balanceChange })
            }
            localStorage.setItem('liquidations', JSON.stringify(liquidationStorage))
            console.log(`${new Date()} - Liquidated user: ${user} Tx: ${tx} --- +${balanceChange.toFixed(2)} USDC`)
        })
    }).catch(error => {
        console.log(`Failed to liquidate :\(`)
    });
}

// if the margin ratio is less than the liquidation ratio just return 1 to move it to the front of the liquidation distance array
// divide the margin ratio by the partial liquidation ratio to get the distance to liquidation for the user
// use div and mod to get the decimal values

const partialLiquidationWithSlippage = () => {
    return PARTIAL_LIQUIDATION_RATIO.toNumber() * (1 + (partialLiquidationSlippage/100))
}

const slipLiq = partialLiquidationWithSlippage()
console.log('partialLiquidationWithSlippage: ' + slipLiq)

const calcDistanceToLiq = (marginRatio) => {
    
    if (marginRatio.toNumber() <= slipLiq) {
        return 1
    } else {
        return marginRatio.div(new BN(slipLiq)).toNumber() + marginRatio.mod(new BN(slipLiq)).toNumber()
    }
    
}

const getMarginRatio = (positions: Array<UserPosition>) => {
    return positions.reduce(
        (positionValue, marketPosition) => {
            const market = _.clearingHouse.getMarket(marketPosition.marketIndex);
            return positionValue.add(
                calculateBaseAssetValue(market, marketPosition)
            );
        },
        ZERO
    );
}





// get all the users from the program and the storage
// add the new users to the storage
// maybe one day only request users which are not in storage

// based on liquidation distance check users for liquidation
const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number], averageMarginRatio: number }> => {
    return new Promise((resolve, reject) => {
        var hrstart = process.hrtime()

        // map the users to check to their ClearingHouseUser
        // and filter out the high margin ratio users
        
        const filtered = [...usersLiquidationDistance].filter(([publicKey, distance]) => { 
            return distance < minLiquidationDistance 
        });

        (async () => {
            const promises = await Promise.all(filtered.map(([publicKey, distance]) : Promise<number> => { 
                return new Promise((innerResolve) => {
                    const userPositionArray = userPositions.get(publicKey) 
                    if (userPositionArray.length > 0) {
                        // send liquidation early to try to front run
                        const marginRatio = getMarginRatio(userPositionArray)
                        const closeToLiquidation = marginRatio.lte(new BN(slipLiq))
                        innerResolve(marginRatio.toNumber()/100)
                        // if the user can be liquidated, liquidate
                        // else update their liquidation distance
                        if (closeToLiquidation) {
                            liq(new PublicKey(publicKey), publicKey)
                        } else {
                            usersLiquidationDistance.set(publicKey, calcDistanceToLiq(marginRatio))
                        }
                    }
                    
                })
            }))
            resolve({numOfUsersChecked: filtered.length, time: process.hrtime(hrstart), averageMarginRatio: promises.reduce((a : number, b : number) => a + b, 0) })
        })();
        
        
        
    })
}


// interval timer state variables
let checkUsersInterval : NodeJS.Timer;
let updateUsersLiquidationDistanceInterval : NodeJS.Timer;
let sendDataInterval : NodeJS.Timer;
let botStopped = false;
let start : [number, number] = [0, 0];
// liquidation bot, where the magic happens
const startWorker = () => {
    _.clearingHouse.subscribe().then(() => {
        // prepare variables for liquidation loop
        let intervalCount = 0
        let numUsersChecked = new Array<number>();
        let totalTime = new Array<number>();
        let avgMarginRatio = new Array<number>();


        const checkUsers = () => {
            if (userPositions.size > 0 && !botStopped) {
                checkUsersForLiquidation().then(({ numOfUsersChecked, time, averageMarginRatio }) => {
                    intervalCount++
                    numUsersChecked.push(Number(numOfUsersChecked))
                    avgMarginRatio.push(Number(averageMarginRatio))
                    totalTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
                })
            }
            
        }

        checkUsersInterval = setInterval(() => {
            checkUsers();
        }, checkUsersInMS)


        const updateUsers = () => {
            if (userPositions.size > 0 && !botStopped) {
                (async() => {
                    await Promise.all([...userPositions].map(([publicKey, userPositionArray]) => {
                        return new Promise(resolve => resolve(usersLiquidationDistance.set(publicKey, calcDistanceToLiq(getMarginRatio(userPositionArray)))))
                    }))
                })()
            }
            
        }

        // update all users liquidation distance every minute
        updateUsersLiquidationDistanceInterval = setInterval(() => {
            updateUsers();
        }, 60 * 1000 * updateLiquidationDistanceInMinutes)


        sendDataInterval = setInterval(() => {
            const timeFromStartToEndOfFirstLoop = process.hrtime(start)
            const data = {
                total: '',
                loopTime: ((Number(timeFromStartToEndOfFirstLoop[0]) + ((Number(timeFromStartToEndOfFirstLoop[1] / 1000000) / 1000)))  / 60).toFixed(2),
                intervalCount,
                workerLoopTimeInMinutes: workerLoopTimeInMinutes,
                checked: {
                    min: Math.min(...numUsersChecked).toFixed(2),
                    avg: parseInt((numUsersChecked.reduce((a, b) => a+b, 0)/intervalCount)+"").toFixed(2),
                    max: Math.max(...numUsersChecked).toFixed(2)
                },
                time: {
                    min: Math.min(...totalTime).toFixed(2),
                    avg: (totalTime.reduce((a, b) => a+b, 0)/intervalCount).toFixed(2),
                    max: Math.max(...totalTime).toFixed(2)
                },
                margin: {
                    min: Math.min(...avgMarginRatio).toFixed(2),
                    avg: ((avgMarginRatio.reduce((a, b) => a+b, 0)/intervalCount)).toFixed(2),
                    max: Math.max(...avgMarginRatio).toFixed(2)
                }
            }
            const x = `cnt | usr | ms | %\n` + 
            `${intervalCount} | ${data.checked.max} | ${data.time.max} | ${data.margin.max}`
            console.log(x);
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
    })
    
}
const processMessage = (pub : string, userPositionArray : Array<UserPosition>) => {
    userPositions.set(pub, userPositionArray.map((up) => {
       return {
        baseAssetAmount: new BN(up.baseAssetAmount, 16),
        lastCumulativeFundingRate: new BN(up.lastCumulativeFundingRate, 16),
        marketIndex: new BN(up.marketIndex, 16),
        quoteAssetAmount: new BN(up.quoteAssetAmount, 16)
       }
    }));
}

interface MessageData {
    pub: string,
    userPositionArray: Array<UserPosition>
}

process.on('message', (data : MessageData) => {
    // console.log(data.userPositionArray)
    processMessage(data.pub, data.userPositionArray)
})

startWorker()
