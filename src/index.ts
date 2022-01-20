import { fork, exec, ChildProcess } from 'child_process';
import { atob } from './util/atob.js';
import fs from 'fs-extra'

// const spinnies = new Spinnies({ spinnerColor: 'blueBright'})
// spinnies.add('main', { text: 'Lmvdzande\'s Liquidation Bot'})

import { randomUUID } from 'crypto'

import { default as _ } from './clearingHouse.js'

import { getTable } from './util/table.js'

import {
    getLiquidationChart,
    getLiquidatorProfitTables,
    updateLiquidatorMap, 
    mapHistoryAccountToLiquidationsArray
} from './liqHistoryVisualizer.js'

import { 
    Markets, 
} from '@drift-labs/sdk';

// import { BN, calculateEstimatedFundingRate, PythClient } from '@drift-labs/sdk';
// import { getPythProgramKeyForCluster, PythConnection } from '@pythnetwork/client';

// CONFIG THE BOT

// how many minutes before users will be fetched from on chain ( get new users )
const userUpdateTimeInMinutes = 60

// how many minutes is considered one loop for the worker
const workerLoopTimeInMinutes = 1

// update all margin ratios every x minutes
const updateAllMarginRatiosInMinutes = 1

// users will be checked every x seconds
const checkUsersEveryMS = 5

// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 )))) + (margin_ratio % (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 ))))
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
// adding on the slipage of 4 % will make the partial_liquidation_ratio 650, so a value of 10 will mean users with margin_ratios less than 6500
const minLiquidationDistance = 2

// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.12 = (700)
// essentially trying to frontrun the transaction 
const partialLiquidationSlippage = 0.8

// how many workers to check for users will there be
const workerCount = 1;

// split the amount of users up into equal amounts for each worker
const splitUsersBetweenWorkers = true

// loop to subscribe users, sometimes there are errors
// so users who were unable to be subscribed to will be subscribed to in the next loop
// loop runs until there are no more failed subscriptions or until there have been ten runs of the loop
const loopSubscribeUser = (newUsers : Array<{ publicKey: string, authority: string}>) : Promise<void> => {
    return new Promise((resolve, reject) => {
        subscribeToUserAccounts(newUsers).then(() => resolve())
    })
}

// holds which worker uuid has which user pubkey
const workerAssignment : Map<string, { worker: string, publicKey: string, authority: string }> = new Map<string, { worker: string, publicKey: string, authority: string }>();

// subscribe to all the users and check if they can be liquidated
// users which are already subscribed to will be ignored
const subscribeToUserAccounts = (programUserAccounts : Array<{ publicKey: string, authority: string }>) : Promise<any> => {
    return new Promise((resolve, reject) => {
        Promise.all(
            programUserAccounts.filter(programUserAccount => {
                if (splitUsersBetweenWorkers) {
                    return (workerAssignment.get(programUserAccount.publicKey) === undefined || workerAssignment.get(programUserAccount.publicKey) === null)
                } else {
                    return true;
                }
            }
                
            ).map((programUserAccount: {publicKey: string, authority: string}, index: number) : Promise<void> => {
                return new Promise((innerResolve) => {
                    if (splitUsersBetweenWorkers) {
                        let worker = [...workers.keys()][index % workerCount];
                        workerAssignment.set(programUserAccount.publicKey, { worker, publicKey: programUserAccount.publicKey, authority: programUserAccount.authority });
                        workers.get(worker).send({ dataSource: 'user', programUserAccount })
                        innerResolve()
                    } else {
                        workers.forEach(worker => {
                            worker.send({ dataSource: 'user', programUserAccount: programUserAccount })
                        })
                        innerResolve()
                    }
                })
            })
        ).then(() => {
            resolve([])
        })
    })
};

const unrealizedPNLMap : Map<string, string> = new Map<string, string>();

interface MarketFunding {
    marketId: number,
    marketSymbol: string,
    ts: number,
    rate: string
}

const fundingRateMap : Map<string, Array<MarketFunding>> = new Map<string, Array<MarketFunding>>();

const getFunding = () => {
    let fundingTable = [];
    const funding = _.genesysgoClearingHouse.getFundingRateHistoryAccount().fundingRateRecords
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


// used to print out the tables and chart to console
const print = async () => {
    if (!_.genesysgoClearingHouse.isSubscribed)
        await _.genesysgoClearingHouse.subscribe(['liquidationHistoryAccount'])
    const userAccount = await _.genesysgoClearingHouse.getUserAccountPublicKey()
    const liquidatorMap = await updateLiquidatorMap(mapHistoryAccountToLiquidationsArray(_.genesysgoClearingHouse.getLiquidationHistoryAccount()))
    const liquidationChart = getLiquidationChart(liquidatorMap, [userAccount.toBase58()])
    const liquidationTables = getLiquidatorProfitTables(liquidatorMap, [userAccount.toBase58()])
    console.clear();
    // Promise.all([...unrealizedPNLMap].sort((a : [string, string], b: [string, string]) => {
    //     return parseInt(b[1]) - parseInt(a[1]);
    // }).slice(0, 10).map(([pub, val]) => {
    //     return new Promise((resolve) => {
    //         _.genesysgoClearingHouse.program.account.user.fetch(new PublicKey(pub)).then((userAccount) => {
    //             _.genesysgoClearingHouse.program.account.userPositions.fetch((userAccount as UserAccount).positions).then(userPositionsAccount => {
    //                resolve(
    //                    { 
    //                        pub,
    //                        positions: (userPositionsAccount as UserPositionsAccount).positions.filter((p : UserPosition) => p.baseAssetAmount.gt(ZERO) || p.baseAssetAmount.lt(ZERO)).map(p => {
    //                         let z = {
    //                             marketIndex: p.marketIndex.toNumber(),
    //                             baseAssetAmount: convertBaseAssetAmountToNumber(p.baseAssetAmount),
    //                             qouteAssetAmount: convertToNumber(p.quoteAssetAmount, QUOTE_PRECISION),
    //                             baseAssetValue: convertToNumber(calculateBaseAssetValue(_.genesysgoClearingHouse.getMarket(p.marketIndex.toNumber()), p), QUOTE_PRECISION),
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
    console.log([getTable(
        ([[...workerData].map(([wrkr, mapData]) => {
            let dataFromMap = JSON.parse(mapData)
            let r =  {
                "Users Within Range": parseFloat(dataFromMap.margin.length),
                "User Count": parseFloat(dataFromMap.userCount),
                "Times Checked": parseFloat(dataFromMap.intervalCount),
                "Total MS": parseFloat(dataFromMap.time.total),
                "User Check MS": dataFromMap.time.total / (dataFromMap.intervalCount *  (dataFromMap.userCount)),
                "Min Margin %": dataFromMap.margin.min
            }
            return r
        }).reduce((a, b) => {
            return {
                "Users Within Range": a["Users Within Range"] + b["Users Within Range"],
                "User Count": a["User Count"]+ b["User Count"],
                "Times Checked": a["Times Checked"] + b["Times Checked"],
                "Total MS": a["Total MS"] + b["Total MS"],
                "User Check MS": a["User Check MS"] + b["User Check MS"],
                "Min Margin %": a["Min Margin %"] > (b["Min Margin %"]) ? (b["Min Margin %"]) : a["Min Margin %"]
            }
        })].map(x => {
            return {
                "Worker": workerCount,
                "Users Within Range": x["Users Within Range"],
                "User Count": x["User Count"],
                "Average Times Checked": parseInt(x["Times Checked"] + "") / workerCount,
                "Average Worker MS": (x["Total MS"] / workerCount).toFixed(2),
                "Average Worker Check MS": ((x["Total MS"] / workerCount) / (x["Times Checked"] / workerCount)).toFixed(2),
                "Average User Check MS": ( x["User Check MS"] / workerCount).toFixed(6),
                "Min Margin %": ( x["Min Margin %"] ).toFixed(6)
            }
        }))

    ), [getTable(getFunding())], [...liquidationTables].map(t => getTable(t)), liquidationChart].flat().join("\n\n"))

}
// map worker uuid to worker child process
const workers : Map<string, ChildProcess> = new Map<string, ChildProcess>();
// holds the data used to print information
const workerData : Map<string, string> = new Map<string, string>();
// used to make sure that print is only called once
let printTimeout : NodeJS.Timer;


// calls the getUsers script as a child proccess
// then sends those new users to the workers
const getNewUsers = () => {
    const newUsersWorker = exec("node --no-warnings --loader ts-node/esm ./src/getUsers.js", (error, stdout, stderr) => {
        if (stdout.includes('done')) {
            setTimeout(() => {
                if (fs.pathExistsSync('./storage/programUserAccounts')) {
                    let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
                    loopSubscribeUser(JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string}>)
                } else {
                    console.error('storage/programUserAccounts doesn\'t exist.... if the file is there and isn\'t empty, just start the bot again!')
                    workers.forEach(worker => worker.kill());
                    process.exit();
                }
                newUsersWorker.kill()
            }, 10000)
        } else {
            console.log(stdout, stderr, error);
            newUsersWorker.kill();
            workers.forEach(worker => worker.kill());
            process.exit();
        }
    });
}

const start = Date.now();

let started = 0;


const startWorker = (workerUUID: string, index: number) => {
    workers.set(workerUUID, 
        fork(
            "./src/worker.js",
            [workerCount,index,workerUUID,workerLoopTimeInMinutes,updateAllMarginRatiosInMinutes,checkUsersEveryMS,minLiquidationDistance,partialLiquidationSlippage*( !splitUsersBetweenWorkers ? (index+1) : 1)].map(x => x + ""),
            { stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ] }
        )
    )
    const worker = workers.get(workerUUID)
    // os.setPriority(worker.pid, -20)
    // if (worker.stderr)
    // worker.stderr.on('data', (data : Buffer) => {
    //     console.log(data.toString());
    // })
    // if (worker.stdout)
    // worker.stdout.on('data', (data: Buffer) => {
    //     console.log(data.toString());
    // })

    worker.on('close', (code, sig) => {
        worker.kill();
        workers.delete(workerUUID)
        startWorker(workerUUID, index);
        console.log('worked died, restarting!')
        setTimeout(() => {
            console.log('sending users to restarted worker')
            let newWorker = workers.get(workerUUID);
            if (splitUsersBetweenWorkers) {
                workerAssignment.forEach((value, key) => {
                    if (workerUUID === value.worker) {
                        newWorker.send({ dataSource: 'user', programUserAccount: { publicKey: value.publicKey, authority: value.authority}})
                    }
                })
            } else {
                let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
                let parsedUsers = JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string}>
                parsedUsers.forEach(user => {
                    newWorker.send({dataSource: 'user', programUserAccount: user})
                })
            }
        }, 5000)
    })
    

    worker.on('message', (data : string) => {
        let d = JSON.parse(data);
        switch(d.type) {
            case 'started':
                if (started < workerCount) {
                    started++
                    console.log(started);
                    if (started === workerCount) {
                        console.clear();
                        if (fs.pathExistsSync('./storage/programUserAccounts')) {
                            let userDataFromStorage = fs.readFileSync('./storage/programUserAccounts', "utf8");
                            loopSubscribeUser(JSON.parse(atob(userDataFromStorage)) as Array<{ publicKey: string, authority: string}>)
                        } else {
                            getNewUsers();
                        }

                        setTimeout(() => {
                            getNewUsers();
                        }, 60 * 1000 * userUpdateTimeInMinutes)
                    }
                }
                break;
            case 'data':
                if (d.data.worker !== undefined && d.data.data !== undefined) {
                    JSON.parse(d.data.data.unrealizedPnLMap).forEach(([pub, val]) => {
                        unrealizedPNLMap.set(pub, val);
                    })
                    d.data.data.checked = {
                        min: Math.min(...d.data.data.checked),
                        avg: (d.data.data.checked.reduce((a, b) => a+b, 0)/d.data.data.checked.length).toFixed(2),
                        max: Math.max(...d.data.data.checked),
                        total: parseInt((d.data.data.checked.reduce((a, b) => a+b, 0))+""),
                    }
                    d.data.data.margin = {
                        min: Math.min(...d.data.data.margin, 0),
                        avg: d.data.data.margin.length === 0 ? 0 : ([...d.data.data.margin].reduce((a, b) => a+b, 0)/(d.data.data.margin.length)).toFixed(2),
                        max: Math.max(...d.data.data.margin, 0),
                        total: ([...d.data.data.margin].reduce((a, b) => a+b, 0)),
                        length: d.data.data.margin.length
                    }
                    d.data.data.time = {
                        min: Math.min(...d.data.data.time).toFixed(2),
                        avg: (d.data.data.time.reduce((a, b) => a+b, 0)/d.data.data.time.length).toFixed(2),
                        max: Math.max(...d.data.data.time).toFixed(2),
                        total: (d.data.data.time.reduce((a, b) => a+b, 0)).toFixed(2),
                    }
                    workerData.set(d.data.worker, JSON.stringify(d.data.data));
                    if (printTimeout) {
                        clearTimeout(printTimeout);
                    }
                    printTimeout = setTimeout(() => print(), 5000)
                }
                break;
            case 'out':
                if (!fs.existsSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out')) {
                    fs.writeFileSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out', '')
                }
                fs.appendFileSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                break;
            case 'error':
                if (!fs.existsSync(process.cwd() + '\\src\\logs\\err-'+start+'.out')) {
                    fs.writeFileSync(process.cwd() + '\\src\\logs\\err-'+start+'.out', '')
                }
                fs.appendFileSync(process.cwd() + '\\src\\logs\\err-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                break;
        }

    })
}


// starts each worker and handles the information being sent back
const startWorkers = (workerCount) : Promise<void> => {
    return new Promise((resolve => {
        for(let x = workers.size; x < workerCount; x++) {
            let workerUUID = randomUUID()
            startWorker(workerUUID, x);
        }
    }));
}

// start the bot
// subscribe to liquidation history for the console table of liquidation history
// start the workers
// subscribe the users
// start the get new users loop
const startLiquidationBot = (workerCount) => {

_.genesysgoClearingHouse.subscribe(["liquidationHistoryAccount", "fundingRateHistoryAccount"]).then(() => {
    
// _.genesysgoClearingHouse.setPollingRate('liquidationHistoryAccount', 10000);
// const startedPolling = _.genesysgoClearingHouse.startPolling('liquidationHistoryAccount');

// _.genesysgoClearingHouse.accountSubscriber.eventEmitter.on('fetchedAccount', (accountType) => {
//     console.log('fetched account ' + accountType);
//     const stopPolling = _.genesysgoClearingHouse.stopPolling('liquidationHistoryAccount');
// })
    
    
    startWorkers(workerCount);
})

}

startLiquidationBot(workerCount)
