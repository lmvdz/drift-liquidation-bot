import { fork, exec, ChildProcess } from 'child_process';
import { atob } from './util/atob.js';
import Spinnies from 'spinnies';
import fs from 'fs'

const spinnies = new Spinnies({ spinnerColor: 'blueBright'})
spinnies.add('main', { text: 'Lmvdzande\'s Liquidation Bot'})

import readline from "readline";

import { randomUUID } from 'crypto'
import { ClearingHouseUser, ClearingHouse, UserAccount, UserPositionsAccount } from '@drift-labs/sdk';
import { PublicKey } from '@solana/web3.js';

import clearingHouse, { default as _ } from './clearingHouse.js'

import { LocalStorage } from 'node-localstorage';
const localStorage = new LocalStorage('./storage');

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
const minLiquidationDistance = 5

// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.0005 = (625.3125)
// essentially trying to frontrun the transaction 
const partialLiquidationSlippage = 0.005



const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();

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
                    user.accountSubscriber.eventEmitter.on("userPositionsData", (payload:UserPositionsAccount) => {
                        let mappedPositions = payload.positions.map(position => {
                            return { 
                                baseAssetAmount: position.baseAssetAmount.toJSON(),
                                lastCumulativeFundingRate: position.lastCumulativeFundingRate.toJSON(),
                                marketIndex: position.marketIndex.toJSON(),
                                quoteAssetAmount: position.quoteAssetAmount.toJSON()
                            }
                        })
                        workers.forEach(worker => {
                            worker.send({ pub: pub.toBase58(), userPositionArray: mappedPositions})
                        })
                    })
                    countSubscribed++
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
                        if (user.isSubscribed) {
                            user.accountSubscriber.eventEmitter.on("userPositionsData", (payload:UserPositionsAccount) => {
                                let mappedPositions = payload.positions.map(position => {
                                    return { 
                                        baseAssetAmount: position.baseAssetAmount.toJSON(),
                                        lastCumulativeFundingRate: position.lastCumulativeFundingRate.toJSON(),
                                        marketIndex: position.marketIndex.toJSON(),
                                        quoteAssetAmount: position.quoteAssetAmount.toJSON()
                                    }
                                })
                                workers.forEach(worker => {
                                    worker.send({ pub: pub.toBase58(), userPositionArray: mappedPositions})
                                })
                            })
                        }
                        
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
const getNewUsers = (workerCount) => {
    console.clear()
    spinnies.update('main', { status: 'spinning', text: 'updating user list' })
    const getUsers = exec("node --no-warnings --loader ts-node/esm ./src/getUsers.js", (error, stdout, stderr) => {
        if (stdout.includes('done')) {
            // spinnies.update('main', { status: 'succeed', text: 'updated user list from chain' })
            (async () => {
                loopSubscribeUser(JSON.parse(atob(localStorage.getItem('programUserAccounts')!)) as Array<{ publicKey: string, authority: string}>)
                getUsers.kill()
            })();
        }
    });
    for(let x = workers.size; x < workerCount; x++) {
        let workerUUID = randomUUID()
        if (workerCount <= 10) {
            spinnies.add(workerUUID.split('-').join('')+'', { text: 'worker - ' + workerUUID });
        }
        workers.set(workerUUID, 
            fork("./src/worker.js",
                [workerUUID,userUpdateTimeInMinutes,workerLoopTimeInMinutes,updateLiquidationDistanceInMinutes,checkUsersInMS,minLiquidationDistance,partialLiquidationSlippage*(x+1)].map(x => x + ""),
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
        worker.stdout.on('data', (data) => {
            if (fs.existsSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out')) {
                fs.writeFileSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out', '')
            }
            fs.appendFileSync(process.cwd() + '\\src\\logs\\worker\\'+workerUUID.split('-').join('')+'.out', data)
            if (workerCount <= 10) {
                spinnies.update(workerUUID.split('-').join(''), { text: 'worker - ' + workerUUID.substring(0, 8) + ' - ' + (partialLiquidationSlippage*(x+1)).toFixed(4) +  '\n' + data  })
            } else if (data.includes('Liquidated')) {
                spinnies.add('liquidation'+randomUUID().split('-')[0], { status: 'succeed', text: data })
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

let inputLoop = (spinnies) => {
    if (botStopped) {
        startQuestion(spinnies);
    } else {
        stopQuestion(spinnies);
    }
}

let startQuestion = (spinnies) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question("type `start #` to start the bot with # of workers\n", function(input) {
        if (input.includes('start')) {
            botStopped = false
            rl.close()
            console.clear()
            console.log('starting bot...')
            let numberOfWorkers = 5;
            let inputInt = parseInt(input.split('start ')[1])
            if (inputInt !== NaN) {
                numberOfWorkers = inputInt
            }
            startLiquidationBot(numberOfWorkers)
        } else {
            rl.close()
            startQuestion(spinnies);
        }
    })
}


let stopQuestion = (spinnies) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.question("type `stop` to stop the bot\n", function(input) {
        if (input.toLowerCase() === 'stop') {
            botStopped = true;
            rl.close()
            console.clear()
            console.log('stopping bot...')
            workers.forEach((worker) => worker.kill());
            inputLoop(spinnies)
        } else {
            rl.close()
            console.clear()
            stopQuestion(spinnies);
        }
    })
}

startLiquidationBot(10)
