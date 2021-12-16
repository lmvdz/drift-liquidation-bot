import pkg from '@project-serum/anchor'
const {Provider, Wallet} = pkg
import { ProgramAccount } from '@project-serum/anchor';
import {
	 ClearingHouse, ClearingHouseUser, PARTIAL_LIQUIDATION_RATIO
} from '@drift-labs/sdk';
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import {
	initialize,
	DriftEnv
} from '@drift-labs/sdk';
import { from_b58 } from "./util/base56.js"
import { btoa } from "./util/btoa.js"
import { atob } from "./util/atob.js"
import { LocalStorage } from 'node-localstorage'
import ora from 'ora'
const localStorage = new LocalStorage('./storage');

import { config } from 'dotenv';
config({path: './.env.local'});



// CONFIG THE LOOP

// how many minutes will one loop last
const liquidationLoopTimeInMinutes = 5
// update the liquidation distance of all users every X minutes
const updateLiquidationDistanceInMinutes = 2.5
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
    const liqSpinner = ora("Attempting to liquidate user")
    clearingHouse.liquidate(pub).then((tx) => {
        liqSpinner.succeed(`Liquidated user: ${user.authority} Tx: ${tx}`);
    }).catch(error => {
        liqSpinner.fail(error)
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
const subscribeToUserAccounts = (programUserAccounts : [{ publicKey: string, authority: string }]) => {
    const subscribingUserAccountsORA = ora('subscribing users').start()
    return new Promise((resolve, reject) => {
        let countSubscribed = 0
        const failedToSubscribe:Array<{publicKey: string, authority: string}> = []

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
                        subscribingUserAccountsORA.succeed('Subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                        resolve(subscribeToUserAccounts(failedToSubscribe as [{ publicKey: string, authority: string }]))
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
                            subscribingUserAccountsORA.succeed('Subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                            resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                        }
                        
                    }).catch(error => {
                        if (!failedToSubscribe.includes(programUserAccount)) {
                            failedToSubscribe.push(programUserAccount)
                        }
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            subscribingUserAccountsORA.succeed('Subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                            resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                        }
                    })
                }
                
            }).catch(error => {
                if (!failedToSubscribe.includes(programUserAccount)) {
                    failedToSubscribe.push(programUserAccount)
                }
                if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                    subscribingUserAccountsORA.succeed('Subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                    resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                }
                
            })
            
        })
    })
};


// get all the users from the program and the storage
// add the new users to the storage
// maybe one day only request users which are not in storage
const getUsers = () => {
    const usersCheck  = ora('Getting users').start()
    return new Promise((resolve, reject) => {
        const programUserAccounts = localStorage.getItem('programUserAccounts')
        if (programUserAccounts !== undefined && programUserAccounts !== null) {
            usersCheck.text = ('User accounts found in local storage')
        } else {
            usersCheck.text = ('No user accounts found in local storage')
        }
        clearingHouse.program.account.user.all().then((newProgramUserAccounts: ProgramAccount<any>[]) => {
            usersCheck.text = ('Retrieved all users')
            if (programUserAccounts !== undefined && programUserAccounts !== null) {
                const existingUserAccounts = JSON.parse(atob(programUserAccounts)) as [{ publicKey: string, authority: string}];
                let existingUserAccountsLength = existingUserAccounts.length
                let newlyAddedCount = 0
                newProgramUserAccounts.forEach((newUserAccount: ProgramAccount) => {
                    if(!existingUserAccounts.some(userAccount => userAccount.publicKey === newUserAccount.publicKey.toBase58())) {
                        existingUserAccounts.push({ publicKey: newUserAccount.publicKey.toBase58(), authority: newUserAccount.account.authority.toBase58()})
                        newlyAddedCount++
                    }
                })
                localStorage.setItem('programUserAccounts', btoa(JSON.stringify(existingUserAccounts)))
                usersCheck.succeed('Updated existing ' + existingUserAccountsLength + ' user accounts with ' + newlyAddedCount + " new accounts.")
            } else {
                localStorage.setItem('programUserAccounts', btoa(JSON.stringify(newProgramUserAccounts.map(userAccount => ({ publicKey: userAccount.publicKey.toBase58(), authority: userAccount.account.authority.toBase58() })))))
                usersCheck.succeed('Stored ' + newProgramUserAccounts.length + ' new accounts to localstorage');
            }
            resolve(JSON.parse(atob(localStorage.getItem('programUserAccounts')!)))
        }).catch(error => {
            console.error(error)
            usersCheck.fail('Failed to retreive all users')
        });
    })
    
}
// based on liquidation distance check users for liquidation
const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number] }> => {
    return new Promise((resolve, reject) => {
        var hrstart = process.hrtime()
        // usersToCheck sorted by liquidation distance
        const usersToCheck: Array<string> = usersSortedByLiquidationDistance()
        // map the users to check to their ClearingHouseUser
        // and filter out the high margin ratio users
        const mappedUsers = usersToCheck.map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) })).filter(u => usersLiquidationDistance.get(u.publicKey) < minLiquidationDistance)
        // loop through each user and check for liquidation
        mappedUsers.forEach(({publicKey, user}, index) => {
            if (user) {
                const [canBeLiquidated, marginRatio] = user.canBeLiquidated()
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
        resolve({numOfUsersChecked: mappedUsers.length, time: process.hrtime(hrstart)})
    })
}

// interval timer state variables
let checkUsersInterval : NodeJS.Timer;
let updateUsersLiquidationDistanceInterval : NodeJS.Timer;

// loop to subscribe users, sometimes there are errors
// so users who were unable to be subscribed to will be subscribed to in the next loop
// loop runs until there are no more failed subscriptions or until there have been ten runs of the loop
let failedSubscriptionLoopsCount = 0
const loopSubscribeUser = (users : [{ publicKey: string, authority: string}]) => {
    subscribeToUserAccounts(users).then(failedToSubscribe => {
        if ((failedToSubscribe as Array<any>).length > 0 && failedSubscriptionLoopsCount < 10) {
            failedSubscriptionLoopsCount++
            loopSubscribeUser(failedToSubscribe as [{ publicKey: string, authority: string}])
        }
            
    })
}

// liquidation bot, where the magic happens
const startLiquidationBot = () : Promise<Map<string, number>> => {
    return new Promise(async (resolve, reject) => {
        // reset the failed subscription loops count
        failedSubscriptionLoopsCount = 0
        // get the users and send them to the subscription loop
        getUsers().then((users) => loopSubscribeUser(users as [{ publicKey: string, authority: string}]))
        const userLiquidationSpinner = ora('Checking users for liquidation').start()

        clearInterval(updateUsersLiquidationDistanceInterval)
        // update all users liquidation distance every minute
        updateUsersLiquidationDistanceInterval = setInterval(() => {
            usersSortedByLiquidationDistance().map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) })).forEach(u => {
                usersLiquidationDistance.set(u.publicKey, calcDistanceToLiq(u.user.canBeLiquidated()[1]))
            })
        }, 60 * 1000 * updateLiquidationDistanceInMinutes)

        // prepare variables for liquidation loop
        let usersCheckedCount = 0
        let numUsersChecked = 0
        let totalTime = 0

        clearInterval(checkUsersInterval)

        // check users every 5 ms
        checkUsersInterval = setInterval(() => {
            checkUsersForLiquidation().then(({numOfUsersChecked, time }) => {
                usersCheckedCount++
                numUsersChecked += numOfUsersChecked
                totalTime += Number(time[0] * 1000) + Number(time[1] / 1000000)
            })
        }, checkUsersInMS)

        // resolve current loop after 2 minutes
        setTimeout(() => {
            userLiquidationSpinner.succeed('Checked approx. ' + parseInt((numUsersChecked/usersCheckedCount)+"") + ' users for liquidation ' + usersCheckedCount + ' times over ' + liquidationLoopTimeInMinutes * 60 + ' seconds.\n\t Average time to check all users was: ' + (totalTime/usersCheckedCount) + 'ms')
            resolve(usersLiquidationDistance)
        }, 60 * 1000 * liquidationLoopTimeInMinutes)
        
    })
}

// loop the bot
let botLoopCount = 0;
const botLoop = (spinner) => {
    // increment bot loop count
    botLoopCount++
    spinner.succeed("Loop Count: " + botLoopCount)
    // start the liquidation bot
    startLiquidationBot().then(() => {
        // once the bot loop has finished, start it again
        botLoop(spinner)
    })
}

const spinner = ora('Starting Bot').start();
// main entry
botLoop(spinner)




