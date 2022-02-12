import { fork, exec, ChildProcess } from 'child_process';
import { atob } from './util/atob.js';
import fs from 'fs-extra'
import bs58 from 'bs58'

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
    Markets, UserPositionsAccount, 
} from '@drift-labs/sdk';
import { TpuConnection } from './tpuClient.js';
import { Connection, ConnectionConfig, PublicKey, Transaction } from '@solana/web3.js';


import { config } from 'dotenv';
config({path: './.env.local'});


const indexConnection = new Connection(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 60 * 1000 } as ConnectionConfig)
const clearingHouse = _.createClearingHouse(indexConnection);
let tpuConnection : TpuConnection = null;


// import { BN, calculateEstimatedFundingRate, PythClient } from '@drift-labs/sdk';
// import { getPythProgramKeyForCluster, PythConnection } from '@pythnetwork/client';

// CONFIG THE BOT

// how many minutes before users will be fetched from storage
// the getUsersLoop.ts script will update the storage every minute
const userUpdateTimeInMinutes = 2

// how many minutes is considered one loop for the worker
// console will be cleared and new table/chart data will be displayed
const workerLoopTimeInMinutes = 1


// check priority every X ms
const highPrioCheckUsersEveryMS = 5
const mediumPrioCheckUsersEveryMS = 1000
const lowPrioCheckUsersEveryMS = 5 * 1000


// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.12 = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 0.8

// the margin ratio which determines which priority bucket the user will be a part of 
const highPriorityMarginRatio = 1000
const mediumPriorityMarginRatio = 2000

// how many instances of the worker.ts script will there be
const workerCount = 1;

// split the amount of users up into equal amounts for each worker
const splitUsersBetweenWorkers = true

// loop to subscribe users, sometimes there are errors
// so users who were unable to be subscribed to will be subscribed to in the next loop
// loop runs until there are no more failed subscriptions or until there have been ten runs of the loop
const loopSubscribeUser = (newUsers : Array<{ publicKey: string, authority: string, positions: string }>) : Promise<void> => {
    return new Promise((resolve, reject) => {
        subscribeToUserAccounts(newUsers).then(() => resolve())
    })
}

// holds which worker uuid has which user pubkey
const workerAssignment : Map<string, { worker: string, publicKey: string, authority: string, positions: string }> = new Map<string, { worker: string, publicKey: string, authority: string, positions: string }>();

// subscribe to all the users and check if they can be liquidated
// users which are already subscribed to will be ignored
const subscribeToUserAccounts = (programUserAccounts : Array<{ publicKey: string, authority: string, positions: string }>) : Promise<any> => {
    return new Promise((resolve, reject) => {
        Promise.all(
            programUserAccounts.filter(programUserAccount => {
                if (splitUsersBetweenWorkers) {
                    return (!workerAssignment.has(programUserAccount.publicKey))
                } else {
                    return true;
                }
            }
                
            ).map((programUserAccount: {publicKey: string, authority: string, positions: string }, index: number) : Promise<void> => {
                return new Promise((innerResolve) => {
                    if (splitUsersBetweenWorkers) {
                        let worker = [...workers.keys()][index % workerCount];
                        workerAssignment.set(programUserAccount.publicKey, { worker, publicKey: programUserAccount.publicKey, authority: programUserAccount.authority, positions: programUserAccount.positions });
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



// used for the funding table
interface MarketFunding {
    marketId: number,
    marketSymbol: string,
    ts: number,
    rate: string
}

const getFunding = () => {
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

// used to print out the tables and chart to console
const print = async () => {
    if (!clearingHouse.isSubscribed)
        await clearingHouse.subscribe(['liquidationHistoryAccount', "fundingRateHistoryAccount"])
    const userAccount = await clearingHouse.getUserAccountPublicKey()
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
    console.log([getTable(
        ([[...workerData].map(([wrkr, mapData]) => {
            let dataFromMap = JSON.parse(mapData)
            let r =  {
                "User Count": parseFloat(dataFromMap.userCount),
                "High Prio": parseInt(dataFromMap.prio.high),
                "Medium Prio": parseInt(dataFromMap.prio.medium),
                "Low Prio": parseInt(dataFromMap.prio.low),
                "Times Checked": parseFloat(dataFromMap.intervalCount),
                "Total MS": parseFloat(dataFromMap.time.total),
                "User Check MS": dataFromMap.time.total / (dataFromMap.intervalCount *  (dataFromMap.userCount)),
                "Min Margin %": dataFromMap.margin.min
            }
            return r
        }).reduce((a, b) => {
            return {
                "High Prio": a["High Prio"] + b["High Prio"],
                "Medium Prio": a["Medium Prio"] + b["Medium Prio"],
                "Low Prio": a["Low Prio"] + b["Low Prio"],
                "User Count": a["User Count"]+ b["User Count"],
                "Times Checked": a["Times Checked"] + b["Times Checked"],
                "Total MS": a["Total MS"] + b["Total MS"],
                "User Check MS": a["User Check MS"] + b["User Check MS"],
                "Min Margin %": a["Min Margin %"] > (b["Min Margin %"]) ? (b["Min Margin %"]) : a["Min Margin %"]
            }
        })].map(x => {
            return {
                "Worker": workerCount,
                "High Prio": x["High Prio"],
                "Medium Prio": x["Medium Prio"] ,
                "Low Prio": x["Low Prio"],
                "User Count": x["User Count"],
                "Average Times Checked": (parseInt(x["Times Checked"] + "") / workerCount).toFixed(0),
                "Average Worker MS Spent": (x["Total MS"] / workerCount).toFixed(2),
                "Average Worker Check MS": ((x["Total MS"] / workerCount) / (x["Times Checked"] / workerCount)).toFixed(2),
                "Average User Check MS": ( x["User Check MS"] / workerCount).toFixed(6),
                "Min Margin %": x["Min Margin %"] !== null ? ( x["Min Margin %"] ).toFixed(2) : '0'
            }
        }))

    ), [getTable(getFunding())], [...liquidationTables].map(t => getTable(t)), liquidationChart].flat().join("\n\n"))
    // reset workerData
    unrealizedPNLMap = new Map<string, string>();
    workerData = new Map<string, string>();
}
// map worker uuid to worker child process
const workers : Map<string, ChildProcess> = new Map<string, ChildProcess>();
// holds the data used to print information
let workerData : Map<string, string> = new Map<string, string>();
// currently unused
let unrealizedPNLMap : Map<string, string> = new Map<string, string>();
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
                    loopSubscribeUser(JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string, positions: string }>)
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

const memusage : Map<string, number> = new Map<string, number>();

const isWin = process.platform === "win32"

interface WorkerStatus {
    started: boolean,
    restarted: boolean,
    restarting: boolean,
    alive: boolean,
    lastCheckTs: number
}

const workerStatus : Map<string, WorkerStatus> = new Map<string, WorkerStatus>();

let getNewUsersInterval : NodeJS.Timer = null;

const startWorker = (workerUUID: string, index: number) => {
    workers.set(workerUUID, 
        fork(
            "./src/worker.js",
            [
                workerCount,
                index,
                workerUUID,
                workerLoopTimeInMinutes,
                highPrioCheckUsersEveryMS,
                mediumPrioCheckUsersEveryMS,
                lowPrioCheckUsersEveryMS,
                partialLiquidationSlippage * ( !splitUsersBetweenWorkers ? (index+1) : 1),
                highPriorityMarginRatio,
                mediumPriorityMarginRatio
            ].map(x => x + ""),
            // { stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ] }
        )
    )
    const worker = workers.get(workerUUID)
    // os.setPriority(worker.pid, -20)

    if (worker.stderr)
    worker.stderr.on('data', (data : Buffer) => {
        console.log(data.toString());
    })
    
    if (worker.stdout)
    worker.stdout.on('data', (data: Buffer) => {
        console.log(data.toString());
    })

    worker.on('data', () => {
        if (worker.stderr) {
            worker.stderr.read();
        }
        if (worker.stdout) {
            worker.stdout.read();
        }
    })
    
    worker.on('uncaughtException', (error) => {
        if (!worker.connected && error.code === 'ERR_IPC_CHANNEL_CLOSED') {
            worker.kill();
            return;
        }
        console.error(error);
    });

    worker.on('unhandledRejection', (error) => {
        if (!worker.connected && error.code === 'ERR_IPC_CHANNEL_CLOSED') {
            worker.kill();
            return;
        }
        console.error(error);
    });

    worker.on('close', (code, sig) => {
        worker.kill()
        workers.delete(workerUUID)
        startWorker(workerUUID, index);
        workerStatus.set(workerUUID, { started: false, alive: false, restarting: true, restarted: false, lastCheckTs: Date.now() })
        console.log('worked died, restarting!')
    })

    worker.on('message', (data : string) => {
        let d = JSON.parse(data);

        if (workerStatus.has(workerUUID)) {
            workerStatus.set(workerUUID, { ...workerStatus.get(workerUUID), alive: true, lastCheckTs: Date.now() });
        } else {
            workerStatus.set(workerUUID, { started: false, restarted: false, restarting: false, alive: true, lastCheckTs: Date.now() });
        }
       
        switch(d.type) {
            case 'memusage':
                memusage.set(workerUUID, d.usedMem);
                break;
            case 'tx':
                const tx = Transaction.from(Buffer.from(d.rawTransaction))
                tpuConnection.tpuClient.sendRawTransaction(tx.serialize()).then((signature) => {
                    transactions.add({ 
                        pub: d.pub,
                        time: Date.now(),
                        worker: workerUUID,
                        tx: signature
                    } as UnconfirmedTx)
                    // worker.send({ dataSource: 'tx', transaction: { signature, failed: false, pub: d.pub } })
                }).catch(error => {
                    transactions.add({ 
                        pub: d.pub,
                        time: Date.now(),
                        worker: workerUUID,
                        tx: bs58.encode(tx.signature)
                    } as UnconfirmedTx)
                    // worker.send({ dataSource: 'tx', transaction: { signature: bs58.encode(tx.signature), failed: true, pub: d.pub } })
                })
                break;
            case 'started':
                if (getNewUsersInterval === null) {
                    getNewUsersInterval = setInterval(() => {
                        console.log('getting new users');
                        if (fs.pathExistsSync('./storage/programUserAccounts')) {
                            let userDataFromStorage = fs.readFileSync('./storage/programUserAccounts', "utf8");
                            loopSubscribeUser(JSON.parse(atob(userDataFromStorage)) as Array<{ publicKey: string, authority: string, positions: string }>)
                        }
                    }, 60 * 1000 * userUpdateTimeInMinutes)
                }
                if (workerStatus.get(workerUUID).restarting) {
                    console.log('sending users to restarted worker ' + workerUUID)
                    let newWorker = workers.get(workerUUID);
                    if (splitUsersBetweenWorkers) {
                        workerAssignment.forEach((value, key) => {
                            if (workerUUID === value.worker) {
                                newWorker.send({ dataSource: 'user', programUserAccount: { publicKey: value.publicKey, authority: value.authority, positions: value.positions }})
                            }
                        })
                    } else {
                        let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
                        let parsedUsers = JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string, positions: string }>
                        parsedUsers.forEach(user => {
                            newWorker.send({dataSource: 'user', programUserAccount: user})
                        })
                    }
                    workerStatus.set(workerUUID, { ...workerStatus.get(workerUUID), restarted: true, restarting: false });
                } else if (started < workerCount) {
                    workerStatus.set(workerUUID, { ...workerStatus.get(workerUUID), alive: true, started: true  });
                    started++
                    if (started === workerCount) {
                        console.clear();
                        if (fs.pathExistsSync('./storage/programUserAccounts')) {
                            let userDataFromStorage = fs.readFileSync('./storage/programUserAccounts', "utf8");
                            loopSubscribeUser(JSON.parse(atob(userDataFromStorage)) as Array<{ publicKey: string, authority: string, positions: string }>)
                        }
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
                    // console.log(d.data.data.margin)
                    d.data.data.margin = {
                        min: Math.min(...d.data.data.margin) / 100,
                        avg: d.data.data.margin.length === 0 ? 0 : ([...d.data.data.margin].reduce((a, b) => a+b, 0)/(d.data.data.margin.length)).toFixed(2),
                        max: Math.max(...d.data.data.margin, 0),
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
                if (isWin) {
                    if (!fs.existsSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out')) {
                        fs.writeFileSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out', '')
                    }
                    fs.appendFileSync(process.cwd() + '\\src\\logs\\worker-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                } else {
                    if (!fs.existsSync(process.cwd() + '/src/logs/worker-'+start+'.out')) {
                        fs.writeFileSync(process.cwd() + '/src/logs/worker-'+start+'.out', '')
                    }
                    fs.appendFileSync(process.cwd() + '/src/logs/worker-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                }
                
                break;
            case 'error':
                if (isWin) {
                    if (!fs.existsSync(process.cwd() + '\\src\\logs\\err-'+start+'.out')) {
                        fs.writeFileSync(process.cwd() + '\\src\\logs\\err-'+start+'.out', '')
                    }
                    fs.appendFileSync(process.cwd() + '\\src\\logs\\err-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                    
                } else {
                    if (!fs.existsSync(process.cwd() + '/src/logs/err-'+start+'.out')) {
                        fs.writeFileSync(process.cwd() + '/src/logs/err-'+start+'.out', '')
                    }
                    fs.appendFileSync(process.cwd() + '/src/logs/err-'+start+'.out', new Date() + ' ' + workerUUID + " " + d.data + '\n')
                }
                break;
        }
        setInterval(() => {
            // kill the worker if the last time it was checked was greater than 5 minutes
            if (workerStatus.get(workerUUID).lastCheckTs < Date.now() - 1000 * 60 * 5) {
                worker.kill();
            }
        }, 1000 * 60)
    })
}


// used for checking transactions which we send through the TPU client
interface UnconfirmedTx {
    pub: string,
    time: number,
    worker: string,
    tx: string
}

const transactions : Set<UnconfirmedTx> = new Set<UnconfirmedTx>();

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

const startLiquidationBot = async (workerCount) => {
    tpuConnection = await TpuConnection.load(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 60 * 1000 } as ConnectionConfig );

    const subscribed = await clearingHouse.subscribe(["liquidationHistoryAccount", "fundingRateHistoryAccount"])
    
    if (subscribed) startWorkers(workerCount);
    
    // restart workers every hour...
    setInterval(() => {
        workers.forEach(worker => {
            worker.kill();
        })
    }, 1000 * 60 * 60)

    // check for transactions and print out total memory usage

    setInterval(() => {
        let used = process.memoryUsage().heapUsed / 1024 / 1024;
        memusage.forEach(workerMemUsed => {
            used += workerMemUsed;
        })
        console.log(`total mem usage: ${used.toFixed(2)} MB`)
    }, 1000 * 5)
    setInterval(() => {
        console.log(`total tx unconfirmed ${transactions.size}`);
        // async because order doesn't matter
        transactions.forEach(async (unconfirmedTx, index) => {
            if (unconfirmedTx.time + (30 * 1000) > Date.now()) {
                indexConnection.getConfirmedTransaction(unconfirmedTx.tx, 'confirmed').then(tx => {
                    const worker = workers.get(unconfirmedTx.worker);
                    if (tx) {
                        if (tx.meta.err) {
                            if (worker.connected)
                                worker.send({ dataSource: 'tx', transaction: { signature: unconfirmedTx.tx, failed: true, pub: unconfirmedTx.pub } })
                        } else {
                            worker.send({ dataSource: 'tx', transaction: { signature: unconfirmedTx.tx, failed: false, pub: unconfirmedTx.pub } })
                        }
                        // console.log('deleted:', transactions.delete(unconfirmedTx));
                    }
                })
                transactions.delete(unconfirmedTx);
            }
        })
    }, 30 * 1000)
}

startLiquidationBot(workerCount)
