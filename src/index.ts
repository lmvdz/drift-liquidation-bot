import { fork, exec, ChildProcess } from 'child_process';
import { atob } from './util/atob.js';
import Spinnies from 'spinnies';
import fs from 'fs-extra'
fs.emptyDir(process.cwd() + '\\src\\logs\\err\\')
fs.emptyDir(process.cwd() + '\\src\\logs\\worker\\')
const spinnies = new Spinnies({ spinnerColor: 'blueBright'})
spinnies.add('main', { text: 'Lmvdzande\'s Liquidation Bot'})

import { randomUUID } from 'crypto'
import { ClearingHouseUser, UserAccount, UserPositionsAccount } from '@drift-labs/sdk';
import { PublicKey } from '@solana/web3.js';

import { default as _ } from './clearingHouse.js'

import { LocalStorage } from 'node-localstorage';
const localStorage = new LocalStorage('./storage');

import { convertUserAccount, convertUserPosition } from './ipcInterface.js';

import table from './util/table.js'

// CONFIG THE LOOP
const userUpdateTimeInMinutes = 60
// how many minutes will one loop of the workes
const workerLoopTimeInMinutes = 1
// update the liquidation distance of all users every X minutes
const updateLiquidationDistanceInMinutes = 2
// check users for liquidation every X milliseconds
const checkUsersInMS = 5
// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 )))) + (margin_ratio % (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 ))))
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
// adding on the slipage of 4 % will make the partial_liquidation_ratio 650, so a value of 10 will mean users with margin_ratios less than 6500
const minLiquidationDistance = 10

// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.0005 = (625.3125)
// essentially trying to frontrun the transaction 
const partialLiquidationSlippage = 0.005

const workerCount = 10

const splitUsersBetweenWorkers = true



const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();
const activeUserEventListeners : Map<string, ActiveListeners> = new Map<string, ActiveListeners>();

interface ActiveListeners { 
    userAccountData: boolean,
    userPositionsData: boolean
}

// loop to subscribe users, sometimes there are errors
// so users who were unable to be subscribed to will be subscribed to in the next loop
// loop runs until there are no more failed subscriptions or until there have been ten runs of the loop
let failedSubscriptionLoopsCount = 0
const loopSubscribeUser = (newUsers : Array<{ publicKey: string, authority: string}>) : Promise<void> => {
    return new Promise((resolve, reject) => {
        subscribeToUserAccounts(newUsers).then((failedToSubscribe) => {
            if ((failedToSubscribe as Array<{ publicKey: string, authority: string}>).length > 0 && failedSubscriptionLoopsCount < 10) {
                failedSubscriptionLoopsCount++
                resolve(loopSubscribeUser(failedToSubscribe as Array<{ publicKey: string, authority: string}>))
            } else {
                resolve()
            }
        })
    })
}

const assignUserToWorker = (pub: PublicKey, user: ClearingHouseUser) => {
    const indexOfUser = [...users.keys()].indexOf(pub.toBase58())
    const workerIndex = indexOfUser % workerCount
    const workerAssignedUUID = [...workers.keys()][workerIndex]
    const activeListeners = activeUserEventListeners.get(pub.toBase58()) || { userPositionsData: false, userAccountData: false } as ActiveListeners
    if (!activeListeners.userPositionsData) {
        user.accountSubscriber.eventEmitter.on("userPositionsData", (payload:UserPositionsAccount) => {
            if (splitUsersBetweenWorkers) {
                workers.get(workerAssignedUUID).send({ dataSource: 'userPositionsData', pub: pub.toBase58(), userAccount: null, userPositionArray:  payload.positions.map(convertUserPosition)})
            } else {
                workers.forEach(worker => {
                    worker.send({ dataSource: 'userPositionsData', pub: pub.toBase58(), userAccount: null, userPositionArray:  payload.positions.map(convertUserPosition)})
                })
            }
            
        })
        activeListeners.userPositionsData = true
    }
    if (!activeListeners.userAccountData) {
        user.accountSubscriber.eventEmitter.on("userAccountData", (payload:UserAccount) => {
            if (splitUsersBetweenWorkers) {
                workers.get(workerAssignedUUID).send({ dataSource: 'userAccountData', pub: pub.toBase58(), userAccount: convertUserAccount(payload), userPositionArray: []})
            } else {
                workers.forEach(worker => {
                    worker.send({ dataSource: 'userAccountData', pub: pub.toBase58(), userAccount: convertUserAccount(payload), userPositionArray: []})
                })
            }
        })
        activeListeners.userAccountData = true
    }
    activeUserEventListeners.set(pub.toBase58(), activeListeners);
    if (splitUsersBetweenWorkers) {
        workers.get(workerAssignedUUID).send({ dataSource: 'preExisting', pub: pub.toBase58(), userAccount: convertUserAccount(user.getUserAccount()), userPositionArray: user.getUserPositionsAccount().positions.map(convertUserPosition)})
    } else {
        workers.forEach(worker => {
            worker.send({ dataSource: 'preExisting', pub: pub.toBase58(), userAccount: convertUserAccount(user.getUserAccount()), userPositionArray: user.getUserPositionsAccount().positions.map(convertUserPosition)})
        })
    }
}

// subscribe to all the users and check if they can be liquidated
// users which are already subscribed to will be ignored
const subscribeToUserAccounts = (programUserAccounts : Array<{ publicKey: string, authority: string }>) : Promise<any> => {
    return new Promise((resolve, reject) => {
        if (botStopped) {
            return
        }
        let countSubscribed = 0
        const failedToSubscribe:Array<{publicKey: string, authority: string}> = []
        if (programUserAccounts.length < 1) {
            resolve (failedToSubscribe)
            return;
        }
        programUserAccounts.forEach((programUserAccount: {publicKey: string, authority: string}, index: number) => {
            if (botStopped) {
                return
            }
            const authority = new PublicKey(programUserAccount.authority)
            const user = ClearingHouseUser.from(
                _.clearingHouse,
                authority
            );
            user.getUserAccountPublicKey().then(pub => {
                if (botStopped) {
                    return
                }
                if (users.has(pub.toBase58()) && users.get(pub.toBase58())?.isSubscribed) {
                    countSubscribed++
                    assignUserToWorker(pub, user)
                    if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                        setTimeout(() => {
                            resolve(failedToSubscribe)
                        }, 1000)
                    }
                    return;
                } else {
                    user.subscribe().then(subscribed => {
                        if (botStopped) {
                            return
                        }
                        users.set(pub.toBase58(), user);
                        assignUserToWorker(pub, user)
                        countSubscribed++
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            setTimeout(() => {
                                resolve(failedToSubscribe)
                            }, 1000)
                        }
                    }).catch(error => {
                        console.error(error)
                        if (!failedToSubscribe.includes(programUserAccount)) {
                            failedToSubscribe.push(programUserAccount)
                        }
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            setTimeout(() => {
                                resolve(failedToSubscribe)
                            }, 1000)
                        }
                    })
                }
                
            }).catch(error => {
                console.error(error)
                if (!failedToSubscribe.includes(programUserAccount)) {
                    failedToSubscribe.push(programUserAccount)
                }
                if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                    setTimeout(() => {
                        resolve(failedToSubscribe)
                    }, 1000)
                }
                
            })
            
        })
    })
};



let botStopped = false;
let start : [number, number] = [0, 0];
const workers : Map<string, ChildProcess> = new Map<string, ChildProcess>();
const workerData : Map<string, string> = new Map<string, string>();
const getNewUsers = (workerCount) => {
    console.clear()
    spinnies.update('main', { status: 'spinning', text: 'updating user list\n' + [userUpdateTimeInMinutes,workerLoopTimeInMinutes,updateLiquidationDistanceInMinutes,checkUsersInMS,minLiquidationDistance,partialLiquidationSlippage].join(' - ') + '\n' })
    const getUsers = exec("node --no-warnings --loader ts-node/esm ./src/getUsers.js", (error, stdout, stderr) => {
        if (stdout.includes('done')) {
            // spinnies.update('main', { status: 'succeed', text: 'updated user list from chain' })
            (async () => {
                loopSubscribeUser(JSON.parse(atob(localStorage.getItem('programUserAccounts')!)) as Array<{ publicKey: string, authority: string}>)
                getUsers.kill()
            })();
        }
    });
    spinnies.add('workers', { text: ""})
    for(let x = workers.size; x < workerCount; x++) {
        let workerUUID = randomUUID()
        if (workerCount <= 10) {
            // spinnies.add(workerUUID.split('-').join('')+'', { text: 'worker - ' + workerUUID });
        }
        workers.set(workerUUID, 
            fork("./src/worker.js",
                [workerUUID,workerLoopTimeInMinutes,updateLiquidationDistanceInMinutes,checkUsersInMS,minLiquidationDistance,partialLiquidationSlippage*( !splitUsersBetweenWorkers ? (x+1) : 1)].map(x => x + ""),
                {
                    stdio: [ 'pipe', 'pipe', (() => {
                        if (fs.existsSync(process.cwd() + '\\src\\logs\\err\\'+workerUUID.split('-').join('')+'.out')) {
                            fs.writeFileSync(process.cwd() + '\\src\\logs\\err\\'+workerUUID.split('-').join('')+'.out', '')
                        }
                        return fs.openSync(process.cwd() + '\\src\\logs\\err\\'+workerUUID.split('-').join('')+'.out', 'w')
                    })(), 'ipc' ]
                }
            )
        )
        const worker = workers.get(workerUUID)
        worker.stdout.on('data', (data : Buffer) => {
            if (fs.existsSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out')) {
                fs.writeFileSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out', '')
            }
            fs.appendFileSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out', data)
            if (workerCount <= 10) {
                // spinnies.update(workerUUID.split('-').join(''), { text: 'worker - ' + workerUUID.substring(0, 8) + ' - ' + (partialLiquidationSlippage*(x+1)).toFixed(4) +  '\n' + data  })
                if (data.toString('utf8').charCodeAt(0) === 123) {
                    let d = JSON.parse(data.toString('utf8'))
                    if (d.worker !== undefined && d.data !== undefined) {
                        workerData.set(d.worker, JSON.stringify(d.data));
                        console.clear();
                        spinnies.update('workers', { text : table([...workerData].map(([wrkr, mapData]) => {
                            let dataFromMap = JSON.parse(mapData)
                            let r =  {
                                "Worker": wrkr.split('-')[4],
                                // "Users Within Distance": dataFromMap.usersChecked,
                                "User Count": dataFromMap.userCount,
                                "Times Checked": dataFromMap.intervalCount,
                                "Total MS": dataFromMap.totalTime,
                                "Check MS per User": dataFromMap.avgCheckMsPerUser,
                                // "Smallest Margin %": dataFromMap.minMargin
                            }
                            if (!splitUsersBetweenWorkers) {
                                r["Margin with Slippage"] =  dataFromMap.slipLiq
                            }
                            return r
                        }).sort((a, b) => a["User Count"] - b["User Count"]))})
                    }
                }
                
                if (data.includes('Liquidated')) {
                    spinnies.add('liquidation'+randomUUID().split('-')[0], { status: 'succeed', text: data })
                }
            }
        })
        worker.stdout.on('close', (error) => {
            worker.kill()
            if (workerCount <= 10) {
                delete spinnies.spinners[workerUUID.split('-').join('')+''];
            }
        })
    }
    start = process.hrtime();

    setTimeout(() => {
        if (botStopped) {
            return
        }
        getNewUsers(workerCount);
    }, 60 * 1000 * userUpdateTimeInMinutes)
}

// liquidation bot, where the magic happens
const startLiquidationBot = (workerCount) => {
    _.clearingHouse.subscribe().then(() => {
        getNewUsers(workerCount);
    })
}

startLiquidationBot(workerCount)
