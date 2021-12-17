
// for some reason I had to split these two imports... commonJS complains
import pkg from '@project-serum/anchor'
const {Provider, Wallet} = pkg
import { ProgramAccount } from '@project-serum/anchor';

// solana web3
import { Connection, PublicKey, Keypair } from '@solana/web3.js'

// used for drift sdk
import {
    ClearingHouse, 
    ClearingHouseUser, 
    PARTIAL_LIQUIDATION_RATIO,
	initialize,
	DriftEnv
} from '@drift-labs/sdk';

// used to convert phantom private key into a usable form
import { from_b58 } from "./util/base56.js"

// used to convert from and to base64 respectively
import { btoa } from "./util/btoa.js"
import { atob } from "./util/atob.js"

// used to store the data, uses the same api calls as window.localStorage but works with nodejs
import { LocalStorage } from 'node-localstorage'
const localStorage = new LocalStorage('./storage');


import Spinnies from 'spinnies';

const spinnies = new Spinnies();

spinnies.add("botLoop", { text: "Waiting to start"})
spinnies.add('getUsers', { status: 'stopped', text: 'Get Users: Waiting for initialization'})
spinnies.add('subscribeUsers', { status: 'stopped', text: 'Subscribe Users: Waiting for initialization'})
spinnies.add('liqDistanceUpdate', { status: 'stopped', text: 'Liquidation Distance: Waiting for initialilzation'})
spinnies.add('loopSpinner', { status: 'stopped', text: 'Check Users: Waiting for initialization'})
spinnies.add('loopSpinnerLast', { status: 'stopped', text: 'User Check History: Waiting for data'})

// used to get environment variables
import { config } from 'dotenv';
config({path: './.env.local'});

// CONFIG THE LOOP

// how many minutes will one loop last
const liquidationLoopTimeInMinutes = 0.5
// update the liquidation distance of all users every X minutes, must be lower than the liquidationLoopTimeInMinutes otherwise won't be called
const updateLiquidationDistanceInMinutes = liquidationLoopTimeInMinutes / 2
// check users for liquidation every X milliseconds
const checkUsersInMS = 5
// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / partial_liquidation_ratio) + (margin_ratio % partial_liquidation_ratio)
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
const minLiquidationDistance = 10


const botKeyEnvVariable = "BOT_KEY"
// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
const botKey = process.env[botKeyEnvVariable]

if (botKey === undefined) {
    console.error('need a ' + botKeyEnvVariable +' env variable');
    process.exit()
}
// setup wallet
let keypair;

try {
    keypair = Keypair.fromSecretKey(
        from_b58(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")!
    );
} catch {
    try {
        keypair = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(botKey))
        );
    } catch {
        console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)')
        process.exit();
    }
}
const botWallet = new Wallet(keypair);


//setup solana rpc connection
// the one provided is the best one as it allows for unlimited TPS
const mainnetConnection = new Connection("https://ssc-dao.genesysgo.net/") 
const provider = new Provider(mainnetConnection, botWallet, Provider.defaultOptions());

//setup drift protocol
const sdkConfig = initialize({ env: 'mainnet-beta' as DriftEnv });
const clearingHouse = ClearingHouse.from(
    mainnetConnection,
    provider.wallet,
    new PublicKey(
        sdkConfig.CLEARING_HOUSE_PROGRAM_ID
    )
)
// setup bot state
const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();
const usersLiquidationDistance : Map<string, number> =  new Map<string, number>();
const usersSortedByLiquidationDistance  = () : Array<string>  => {
    const publicKeys = ([...usersLiquidationDistance].map(e => { return e[0]; }) as Array<string>);
    publicKeys.sort((a, b) => { 
        return usersLiquidationDistance.get(a)! - usersLiquidationDistance.get(b)!
    })
    return publicKeys
}
// liquidation helper function
const liq = (pub:PublicKey, user:ClearingHouseUser) => {
    const t = new Date();
    spinnies.add('liqSpinner-'+t, { status: 'spinning', text: "Attempting to liquidate user: "  + pub})
    clearingHouse.liquidate(pub).then((tx) => {
        spinnies.succeed('liqSpinner-'+t, { text: (`Liquidated user: ${user.authority} Tx: ${tx}`) });
    }).catch(error => {
        spinnies.fail('liqSpinner-'+t, { text: error })
    });
}

// if the margin ratio is less than the liquidation ratio just return 1 to move it to the front of the liquidation distance array
// divide the margin ratio by the partial liquidation ratio to get the distance to liquidation for the user
// use div and mod to get the decimal values
const calcDistanceToLiq = (marginRatio) => {
    if (marginRatio.toNumber() <= PARTIAL_LIQUIDATION_RATIO.toNumber()) {
        return 1
    } else {
        return marginRatio.div(PARTIAL_LIQUIDATION_RATIO).toNumber() + marginRatio.mod(PARTIAL_LIQUIDATION_RATIO).toNumber()
    }
    
}


// subscribe to all the users and check if they can be liquidated
// users which are already subscribed to will be ignored
const subscribeToUserAccounts = (programUserAccounts : Array<{ publicKey: string, authority: string }>) => {
    return new Promise((resolve, reject) => {
        let countSubscribed = 0
        const failedToSubscribe:Array<{publicKey: string, authority: string}> = []
        if (programUserAccounts.length < 1) {
            resolve (failedToSubscribe)
            return;
        }
        spinnies.update('subscribeUsers', { status: 'spinning', text: 'Subscribing to user accounts' })
        programUserAccounts.forEach((programUserAccount: {publicKey: string, authority: string}, index: number) => {
            const authority = new PublicKey(programUserAccount.authority)
            const user = ClearingHouseUser.from(
                clearingHouse,
                authority
            );
            user.getUserAccountPublicKey().then(pub => {
                if (users.has(pub.toBase58()) && users.get(pub.toBase58())?.isSubscribed) {
                    countSubscribed++
                    if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                        spinnies.succeed('subscribeUsers', { text: 'Subscribed to ' + countSubscribed + ', and failed to subscribe to ' + failedToSubscribe.length + ' user accounts'})
                        setTimeout(() => {
                            resolve(failedToSubscribe as Array<{ publicKey: string, authority: string }>)
                        }, 1000)
                    }
                    return;
                } else {
                    user.subscribe().then(subscribed => {
                        users.set(pub.toBase58(), user);
                        countSubscribed++
                        const [canBeLiquidated, marginRatio] = user.canBeLiquidated();
                        if(canBeLiquidated) {
                            liq(pub, user)
                        } else {
                            usersLiquidationDistance.set(pub.toBase58(), calcDistanceToLiq(marginRatio))
                        }
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            spinnies.succeed('subscribeUsers', { text: 'Subscribed to ' + countSubscribed + ', and failed to subscribe to ' + failedToSubscribe.length + ' user accounts'})
                            setTimeout(() => {
                                resolve(failedToSubscribe as Array<{ publicKey: string, authority: string }>)
                            }, 1000)
                        }
                    }).catch(error => {
                        console.error(error)
                        if (!failedToSubscribe.includes(programUserAccount)) {
                            failedToSubscribe.push(programUserAccount)
                        }
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            spinnies.succeed('subscribeUsers', { text: 'Subscribed to ' + countSubscribed + ', and failed to subscribe to ' + failedToSubscribe.length + ' user accounts' })
                            setTimeout(() => {
                                resolve(failedToSubscribe as Array<{ publicKey: string, authority: string }>)
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
                    spinnies.succeed('subscribeUsers', { text: 'Subscribed to ' + countSubscribed + ', and failed to subscribe to ' + failedToSubscribe.length + ' user accounts' })
                    setTimeout(() => {
                        resolve(failedToSubscribe as Array<{ publicKey: string, authority: string }>)
                    }, 1000)
                }
                
            })
            
        })
    })
};


// get all the users from the program and the storage
// add the new users to the storage
// maybe one day only request users which are not in storage
const getUsers = () => {
    return new Promise((resolve, reject) => {
        spinnies.update('getUsers', { status: 'spinning', text: 'Getting users' })
        const programUserAccounts = localStorage.getItem('programUserAccounts')
        if (programUserAccounts !== undefined && programUserAccounts !== null) {
            spinnies.update('getUsers', { text: 'User accounts found in local storage' })
        } else {
            spinnies.update('getUsers', { text: 'No user accounts found in local storage' })
        }
        clearingHouse.program.account.user.all().then((newProgramUserAccounts: ProgramAccount<any>[]) => {
            spinnies.update('getUsers', { text: 'Retrieved all users' })
            if (programUserAccounts !== undefined && programUserAccounts !== null) {
                const existingUserAccounts = JSON.parse(atob(programUserAccounts)) as Array<{ publicKey: string, authority: string}>;
                let existingUserAccountsLength = existingUserAccounts.length
                let newlyAddedCount = 0
                newProgramUserAccounts.forEach((newUserAccount: ProgramAccount) => {
                    if(!existingUserAccounts.some(userAccount => userAccount.publicKey === newUserAccount.publicKey.toBase58())) {
                        existingUserAccounts.push({ publicKey: newUserAccount.publicKey.toBase58(), authority: newUserAccount.account.authority.toBase58()})
                        newlyAddedCount++
                    }
                })
                localStorage.setItem('programUserAccounts', btoa(JSON.stringify(existingUserAccounts)))
                spinnies.succeed('getUsers', { text: 'Updated existing ' + existingUserAccountsLength + ' user accounts with ' + newlyAddedCount + " new accounts." })
            } else {
                localStorage.setItem('programUserAccounts', btoa(JSON.stringify(newProgramUserAccounts.map(userAccount => ({ publicKey: userAccount.publicKey.toBase58(), authority: userAccount.account.authority.toBase58() })))))
                spinnies.succeed('getUsers', { text: 'Stored ' + newProgramUserAccounts.length + ' new accounts to localstorage' });
            }
            resolve(JSON.parse(atob(localStorage.getItem('programUserAccounts')!)) as Array<{ publicKey: string, authority: string}>)
        }).catch(error => {
            console.error(error)
            spinnies.fail('getUsers', { text: 'Failed to retreive all users' })
        });
    })
    
}
// based on liquidation distance check users for liquidation
const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number], averageMarginRatio: number }> => {
    return new Promise((resolve, reject) => {
        var hrstart = process.hrtime()
        // usersToCheck sorted by liquidation distance
        const usersToCheck: Array<string> = usersSortedByLiquidationDistance()

        // map the users to check to their ClearingHouseUser
        // and filter out the high margin ratio users
        const mappedUsers = usersToCheck.map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) })).filter(u => usersLiquidationDistance.get(u.publicKey) < minLiquidationDistance)
        
        let averageMarginRatio = 0
        
        // loop through each user and check for liquidation
        mappedUsers.forEach(({publicKey, user}, index) => {
            if (user) {
                const [canBeLiquidated, marginRatio] = user.canBeLiquidated()
                averageMarginRatio += marginRatio.toNumber()
                // console.log('user :' + publicKey + ' has margin ratio: ' + marginRatio.toNumber())
                // if the user can be liquidated, liquidate
                // else update their liquidation distance
                if (canBeLiquidated) {
                    liq(new PublicKey(publicKey), user)
                } else {
                    usersLiquidationDistance.set(publicKey, calcDistanceToLiq(marginRatio))

                }
            }
        })
        resolve({numOfUsersChecked: mappedUsers.length, time: process.hrtime(hrstart), averageMarginRatio: averageMarginRatio })
    })
}

// interval timer state variables
let checkUsersInterval : NodeJS.Timer;
let updateUsersLiquidationDistanceInterval : NodeJS.Timer;

// loop to subscribe users, sometimes there are errors
// so users who were unable to be subscribed to will be subscribed to in the next loop
// loop runs until there are no more failed subscriptions or until there have been ten runs of the loop
let failedSubscriptionLoopsCount = 0
const loopSubscribeUser = (newUsers : Array<{ publicKey: string, authority: string}>) => {
    if (spinnies.pick('subscribeUsers').status === 'stopped') {
        spinnies.update('subscribeUsers', { status: "spinning", text: "User data recieved"})
    } else if (spinnies.pick('subscribeUsers').status === 'succeed') {
        failedSubscriptionLoopsCount = 0
    }
    subscribeToUserAccounts(newUsers).then((failedToSubscribe : Array<{ publicKey: string, authority: string}>) => {
        if (failedToSubscribe.length > 0 && failedSubscriptionLoopsCount < 10) {
            failedSubscriptionLoopsCount++
            loopSubscribeUser(failedToSubscribe as Array<{ publicKey: string, authority: string}>)
        } else {
            // update all users liquidation distance every minute
            updateUsersLiquidationDistanceInterval = setInterval(() => {
                let startTime = Date.now()
                let nextIntervalStartTime = startTime + 60 * 1000 * updateLiquidationDistanceInMinutes
                spinnies.update('liqDistanceUpdate', { status: 'spinning', text: 'Updating liquidation distance for all users.'})
                usersSortedByLiquidationDistance().map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) })).forEach(u => {
                    usersLiquidationDistance.set(u.publicKey, calcDistanceToLiq(u.user.canBeLiquidated()[1]))
                })
                spinnies.succeed('liqDistanceUpdate', { text: 'Updated liquidation distance for all users.'})
                setTimeout(() => {
                    const interval = setInterval(() => {
                        spinnies.update('liqDistanceUpdate', { status: 'spinning', text: 'Next liquidation distance update in ' + Math.max(0, (nextIntervalStartTime - Date.now()) / 1000) + ' seconds.'})
                    }, 5000)
                    setTimeout(() => {
                        clearInterval(interval)
                    }, 30 * 1000 * updateLiquidationDistanceInMinutes)
                }, 30 * 1000 * updateLiquidationDistanceInMinutes)
            }, 60 * 1000 * updateLiquidationDistanceInMinutes)

            // prepare variables for liquidation loop
            let intervalCount = 0
            let numUsersChecked = Array<number>();
            let totalTime = Array<number>();
            let avgMarginRatio = Array<number>();

            spinnies.update('loopSpinner', { status: 'spinning', text: 'Checking users for liquidation' })
            checkUsersInterval = setInterval(() => {
                checkUsersForLiquidation().then(({ numOfUsersChecked, time, averageMarginRatio }) => {
                    // spinnies.update('loopSpinner', { text: 'Users checked: ' + numOfUsersChecked + ', took: '+ Number(time[0] * 1000) + Number(time[1] / 1000000) + 'ms, avg margin ratio: ' +  averageMarginRatio/numOfUsersChecked})
                    intervalCount++
                    numUsersChecked.push(Number(numOfUsersChecked))
                    avgMarginRatio.push(Number(averageMarginRatio))
                    totalTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
                })
            }, checkUsersInMS)

            setTimeout(() => {
                clearInterval(checkUsersInterval)
                clearInterval(updateUsersLiquidationDistanceInterval)
                spinnies.update('loopSpinnerLast', { 
                    status: 'succeed', 
                    succeedColor: 'green', 
                    text: 'Last Run Statistics\n'+
                        'Looped ' + intervalCount + ' times over ' + liquidationLoopTimeInMinutes * 60 + ' seconds.\n\n(min / avg / max)\n\n' +
                        'Checked: ' + Math.min(...numUsersChecked) + ' / ' + parseInt((numUsersChecked.reduce((a, b) => a+b)/intervalCount)+"") + ' / ' + Math.max(...numUsersChecked) + ' users\n' + 
                        'Time to check was: ' + Math.min(...totalTime) + ' / ' + (totalTime.reduce((a, b) => a+b)/intervalCount).toFixed(2) + ' / ' + Math.max(...totalTime) + ' ms\n' + 
                        'Margin ratio was: ' + Math.min(...avgMarginRatio) + ' / ' + (avgMarginRatio.reduce((a, b) => a+b)/numUsersChecked.reduce((a, b) => a+b)).toFixed(2) + ' / ' + Math.max(...avgMarginRatio)
                    }
                )
                spinnies.update('loopSpinner', { status: 'stopped', text: 'Bot cooling down!' })
                spinnies.update('getUsers', { status: 'stopped', text: 'Bot cooling down!' })
                setTimeout(() => {
                    getUsers().then((users) => loopSubscribeUser(users as Array<{ publicKey: string, authority: string}>))
                }, 5000)
            }, 60 * 1000 * liquidationLoopTimeInMinutes)
        }
    })
}

let str = "Bot started... Printing Money... ";
let str2 = "Brrr!"
let str2Length = str2.length
let index = 0
// liquidation bot, where the magic happens
const startLiquidationBot = () => {
    spinnies.update("botLoop", { text: str })
    setInterval(() => {
        spinnies.update("botLoop", { text: str + str2.substring(0, index)})
        index++
        if (index > str2Length) {
            index = 0
        }
    }, 1000)
    getUsers().then((users) => loopSubscribeUser(users as Array<{ publicKey: string, authority: string}>))
}

startLiquidationBot()




