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
import { LocalStorage } from 'node-localstorage'
import ora from 'ora'
const localStorage = new LocalStorage('./storage');

import { config } from 'dotenv';
config({path: './.env.local'});
const mainnetConnection = new Connection("https://ssc-dao.genesysgo.net/")
const privateKey = process.env.BOT_KEY

if (privateKey === undefined) {
    console.error('need a BOT_KEY env variable');
    process.exit()
}

const sdkConfig = initialize({ env: 'mainnet-beta' as DriftEnv });
const keypair = Keypair.fromSecretKey(
    from_b58(privateKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")!
);
const privateWallet = new Wallet(keypair);
const provider = new Provider(mainnetConnection, privateWallet, Provider.defaultOptions());

const clearingHouse = ClearingHouse.from(
    mainnetConnection,
    provider.wallet,
    new PublicKey(
        sdkConfig.CLEARING_HOUSE_PROGRAM_ID
    )
)

const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();
const usersLiquidationDistance : Map<string, number> =  new Map<string, number>();
const usersSortedByLiquidationDistance  = () : Array<string>  => {
    const publicKeys = ([...usersLiquidationDistance].map(e => { return e[0]; }) as Array<string>);
    publicKeys.sort((a, b) => { 
        return usersLiquidationDistance.get(a)! - usersLiquidationDistance.get(b)!
    })
    return publicKeys
}

const liq = (pub:PublicKey, user:ClearingHouseUser) => {
    const liqSpinner = ora("Attempting to liquidate user")
    clearingHouse.liquidate(pub).then((tx) => {
        liqSpinner.succeed(`Liquidated user: ${user.authority} Tx: ${tx}`);
    }).catch(error => {
        liqSpinner.fail(error)
    });
}

const calcDistanceToLiq = (marginRatio) => {
    return marginRatio.div(PARTIAL_LIQUIDATION_RATIO).toNumber() + marginRatio.mod(PARTIAL_LIQUIDATION_RATIO).toNumber()
}

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
                        subscribingUserAccountsORA.succeed('1. subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
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
                            subscribingUserAccountsORA.succeed('2. subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                            resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                        }
                        
                    }).catch(error => {
                        if (!failedToSubscribe.includes(programUserAccount)) {
                            failedToSubscribe.push(programUserAccount)
                        }
                        if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                            subscribingUserAccountsORA.succeed('3. subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                            resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                        }
                    })
                }
                
            }).catch(error => {
                if (!failedToSubscribe.includes(programUserAccount)) {
                    failedToSubscribe.push(programUserAccount)
                }
                if (countSubscribed + failedToSubscribe.length >= programUserAccounts.length) {
                    subscribingUserAccountsORA.succeed('4. subscribed to ' + countSubscribed + ' accounts, and failed to subscribe to ' + failedToSubscribe.length + ' accounts')
                    resolve(subscribeToUserAccounts(failedToSubscribe  as [{ publicKey: string, authority: string }]))
                }
                
            })
            
        })
    })
};
const btoa = (text) => {
    return Buffer.from(text, 'binary').toString('base64');
};
const atob = (base64) => {
    return Buffer.from(base64, 'base64').toString('binary');
};

const getUsers = () => {
    const usersCheck  = ora('Getting users').start()
    return new Promise((resolve, reject) => {
        const programUserAccounts = localStorage.getItem('programUserAccounts')
        if (programUserAccounts !== undefined && programUserAccounts !== null) {
            usersCheck.text = ('user accounts found in local storage')
        } else {
            usersCheck.text = ('no user accounts found in local storage')
        }
        clearingHouse.program.account.user.all().then((newProgramUserAccounts: ProgramAccount<any>[]) => {
            usersCheck.text = ('retrieved all users')
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
                usersCheck.succeed('updated existing ' + existingUserAccountsLength + ' user accounts with ' + newlyAddedCount + " new accounts.")
            } else {
                localStorage.setItem('programUserAccounts', btoa(JSON.stringify(newProgramUserAccounts.map(userAccount => ({ publicKey: userAccount.publicKey.toBase58(), authority: userAccount.account.authority.toBase58() })))))
                usersCheck.succeed('stored ' + newProgramUserAccounts.length + ' new accounts to localstorage');
            }
            resolve(JSON.parse(atob(localStorage.getItem('programUserAccounts')!)))
        }).catch(error => {
            console.error(error)
            usersCheck.fail('failed to retreive all users')
        });
    })
    
}

const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number] }> => {
    return new Promise((resolve, reject) => {
        var hrstart = process.hrtime()
        const usersToCheck: Array<string> = usersSortedByLiquidationDistance()
        const mappedUsers = usersToCheck.map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) }))
        mappedUsers.filter(u => usersLiquidationDistance.get(u.publicKey) < 1000).forEach(({publicKey, user}, index) => {
            if (user) {
                const [canBeLiquidated, marginRatio] = user.canBeLiquidated()
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

let checkUsersInterval : NodeJS.Timer;
let updateUsersLiquidationDistanceInterval : NodeJS.Timer;

const loopSubscribeUser = (users : [{ publicKey: string, authority: string}]) => {
    subscribeToUserAccounts(users).then(failedToSubscribe => {
        if ((failedToSubscribe as Array<any>).length > 0)
            loopSubscribeUser(failedToSubscribe as [{ publicKey: string, authority: string}])
    })
}

const startLiquidationBot = () : Promise<Map<string, number>> => {
    return new Promise(async (resolve, reject) => {
        getUsers().then((users) => loopSubscribeUser(users as [{ publicKey: string, authority: string}]))
        const userLiquidationSpinner = ora('Checking users for liquidation').start()

        let usersCheckedCount = 0
        let numUsersChecked = 0
        let totalTime = 0

        clearInterval(checkUsersInterval)
        clearInterval(updateUsersLiquidationDistanceInterval)
        

        // update all users liquidation distance every minute
        updateUsersLiquidationDistanceInterval = setInterval(() => {
            usersSortedByLiquidationDistance().map(checkingUser => ({ publicKey: checkingUser, user: users.get(checkingUser) })).forEach(u => {
                usersLiquidationDistance.set(u.publicKey, calcDistanceToLiq(u.user.canBeLiquidated()[1]))
            })
        }, 60 * 1000)

        // check users every 5 ms
        checkUsersInterval = setInterval(() => {
            checkUsersForLiquidation().then(({numOfUsersChecked, time }) => {
                usersCheckedCount++
                numUsersChecked += numOfUsersChecked
                totalTime += Number(time[0] * 1000) + Number(time[1] / 1000000)
            })
        }, 5)

        // end current loop after 2 minutes
        setTimeout(() => {
            userLiquidationSpinner.succeed('Checked approx. ' + parseInt((numUsersChecked/usersCheckedCount)+"") + ' users for liquidation ' + usersCheckedCount + ' times. Average time to check all users was: ' + (totalTime/usersCheckedCount) + 'ms')
            resolve(usersLiquidationDistance)
        }, 60 * 1000 * 2)
        
    })
}

let botLoopCount = 0;
const botLoop = (spinner) => {
    botLoopCount++
    spinner.succeed("Loop Count: " + botLoopCount)
    startLiquidationBot().then(() => {
        botLoop(spinner)
    })
}

const spinner = ora('Starting Bot').start();
botLoop(spinner)




