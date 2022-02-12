import { atob } from './util/atob.js';
import fs from 'fs-extra'
import bs58 from 'bs58'
import { default as _ } from './clearingHouse.js'
import { 
    UserPositionsAccount, 
    BN_MAX,
    calculateBaseAssetValue,
    calculatePositionFundingPNL,
    ClearingHouse,
    Market,
    PARTIAL_LIQUIDATION_RATIO,
    PRICE_TO_QUOTE_PRECISION,
    TEN_THOUSAND,
    UserAccount,
    UserPosition,
    ZERO,
    BN,
    PollingAccountSubscriber,
    getUserAccountPublicKey} from '@drift-labs/sdk';
import { TpuConnection } from './tpuClient.js';
import axios from 'axios';
import { ConnectionConfig, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';


import { config } from 'dotenv';
config({path: './.env.local'});

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

const slipLiq = new BN(PARTIAL_LIQUIDATION_RATIO.toNumber() * (1 + (partialLiquidationSlippage/100)));

// the margin ratio which determines which priority bucket the user will be a part of 
const highPriorityMarginRatio = 1000
const mediumPriorityMarginRatio = 2000



interface User {
    publicKey: string,
    authority: string,
    positions: string,
    accountData: UserAccount,
    userAccountPublicKey: PublicKey,
    positionsAccountData: UserPositionsAccount,
    liquidationInstruction: TransactionInstruction,
    marginRatio: BN,
    prio: Priority
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

	let pnlAssetAmount = (marketPosition.baseAssetAmount.gt(ZERO) ? baseAssetValue.sub(marketPosition.quoteAssetAmount) : marketPosition.quoteAssetAmount.sub(baseAssetValue));

	if (withFunding) {
		pnlAssetAmount = pnlAssetAmount.add(calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION));
	}

	return pnlAssetAmount;
}

const getMarginRatio = (clearingHouse : ClearingHouse, user: User) => {
    const positions = user.positionsAccountData.positions;
    

    if (positions.length === 0) {
        return BN_MAX;
    }

    let totalPositionValue = ZERO, unrealizedPNL = ZERO

    positions.forEach(position => {
        const market = clearingHouse.getMarket(position.marketIndex);
        if (market !== undefined) {
            const baseAssetAmountValue = calculateBaseAssetValue(market, position);
            totalPositionValue = totalPositionValue.add(baseAssetAmountValue);
            unrealizedPNL = unrealizedPNL.add(calculatePositionPNL(market, position, baseAssetAmountValue, true));
        } else {
            console.log(user.accountData.positions.toBase58(), user.publicKey);
            console.log(market, position.marketIndex.toString());
            console.log('market undefined', market);
        }
        
    })

    // unrealizedPnLMap.set(user.publicKey, unrealizedPNL.toString());

    if (totalPositionValue.eq(ZERO)) {
        return BN_MAX;
    }

    return (
        user.accountData.collateral.add(unrealizedPNL) ??
        ZERO
    ).mul(TEN_THOUSAND).div(totalPositionValue);
}


const checkForLiquidation = (clearingHouse: ClearingHouse, userMap: Map<string, User>, pub : string, tpuConnection: TpuConnection) => {    
    const user = userMap.get(pub)
    user.marginRatio = getMarginRatio(clearingHouse, user);
    if (user.marginRatio.lte(slipLiq))
        liquidate(clearingHouse, userMap, user, tpuConnection);
}

const checkBucket = (clearingHouse : ClearingHouse, userMap: Map<string, User>, bucket: PollingAccountSubscriber, tpuConnection : TpuConnection) => {
    const start = process.hrtime();
    const keys = bucket.getAllKeys();
    keys.forEach(async key => checkForLiquidation(clearingHouse, userMap, key, tpuConnection))
    // numUsersChecked.push(keys.length)
    const time = process.hrtime(start);
    // checkTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
}


const wrapInTx = (instruction: TransactionInstruction) : Transaction  => {
	return new Transaction().add(instruction);
}

const liquidate = (clearingHouse: ClearingHouse, userMap: Map<string, User>, user: User, tpuConnection: TpuConnection) : Promise<string> => {
    return new Promise(async (resolve, reject) => {
        let instruction = user.liquidationInstruction
        if (instruction === undefined) {
            instruction = await prepareUserLiquidationIX(clearingHouse, userMap, user)
        }
        let tx = wrapInTx(instruction)
        tx.recentBlockhash = (await clearingHouse.connection.getRecentBlockhash()).blockhash;
        tx.feePayer = clearingHouse.wallet.publicKey
        tx = await clearingHouse.wallet.signTransaction(tx)
        resolve(bs58.encode((await tpuConnection.tpuClient.sendRawTransaction(tx.serialize()))));
    })
}

const prepareUserLiquidationIX = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, user: User) : Promise<TransactionInstruction> => {
    if (user.userAccountPublicKey === undefined || user.userAccountPublicKey === null) {
        user.userAccountPublicKey = await getUserAccountPublicKey(clearingHouse.program.programId, new PublicKey(user.authority));
        userMap.set(user.publicKey, user);
    }
    const liquidationInstruction = await prepareLiquidationIX(clearingHouse, userMap, user.publicKey, user.userAccountPublicKey);
    return liquidationInstruction;
}

const prepareLiquidationIX = (clearingHouse: ClearingHouse, userMap: Map<string, User>, userPub: string, userAccountPub : PublicKey) : Promise<TransactionInstruction> => {
    return new Promise((resolve) => {
        clearingHouse.getLiquidateIx(userAccountPub).then( (instruction: TransactionInstruction) => {
            // console.error(instruction)
            userMap.set(userPub, { ...userMap.get(userPub), liquidationInstruction: instruction });
            resolve(instruction);
        })
    })
}


enum Priority {
    'high',
    'medium',
    'low'
}

const getPrio = (user : User) => {
    return (user.marginRatio.lte(new BN(highPriorityMarginRatio)) ? Priority.high : (user.marginRatio.lte(new BN(mediumPriorityMarginRatio)) ? Priority.medium : Priority.low));
}

const sortUser = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map< Priority, PollingAccountSubscriber>, user: User) => {
    user.marginRatio = getMarginRatio(clearingHouse, user);
    let currentPrio = user.prio;
    let newPrio = getPrio(user);
    if (currentPrio !== newPrio) {
        if (currentPrio !== undefined)
        accountSubscriberBucketMap.get(currentPrio).removeAccountsToPoll(user.publicKey);

        userMap.set(user.publicKey, { ...user, prio: newPrio})

        accountSubscriberBucketMap.get(newPrio).addAccountToPoll(user.publicKey, 'user', user.publicKey, async (data: UserAccount) => {
            // console.log('updated user', 'account data', user.publicKey)
            let newData = { ...userMap.get(user.publicKey), accountData: data } as User
            userMap.set(user.publicKey, newData);
            sortUser(clearingHouse, userMap, accountSubscriberBucketMap, newData);
        });

        accountSubscriberBucketMap.get(newPrio).addAccountToPoll(user.publicKey, 'userPositions', user.positions, async (data: UserPositionsAccount) => {
            // console.log(data);
            // console.log('updated user', 'positions data', user.publicKey)
            let oldData = userMap.get(user.publicKey);
            let newData = { ...oldData, positionsAccountData: data } as User;
            newData.marginRatio = getMarginRatio(clearingHouse, newData);
            // newData.liquidationInstruction = await prepareUserLiquidationIX(newData);
            userMap.set(user.publicKey, newData);
            sortUser(clearingHouse, userMap, accountSubscriberBucketMap, newData);
        });

    }
}

const sortUsers = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>) => {
    [...userMap.values()].forEach(async user => sortUser(clearingHouse, userMap, accountSubscriberBucketMap, user));
}

function sleep(milliseconds) {  
    return new Promise(resolve => setTimeout(resolve, milliseconds));  
}

function chunkArray(array : Array<any>, chunk_size : number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
} 

const setupUsers = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, users: Array<User>, tpuConnection: TpuConnection) => {
    let usersSetup = []

    usersSetup = chunkArray(await Promise.all(users.map(async (u, index) => {
        return {
            index,
            ...u
        }
    })), 100)

    await Promise.all(usersSetup.map(async (userArray, index) => {
        const userAccountKeys = userArray.map(u => u.publicKey)
        const userPositions = userArray.map(u => u.positions)
        sleep((index + 1) * 2000).then(() => {
            //@ts-ignore
            axios.post(tpuConnection._rpcEndpoint, [{
                jsonrpc: "2.0",
                id: "1",
                method: "getMultipleAccounts",
                params: [
                    userAccountKeys,
                  {
                    commitment: "processed",
                  },
                ],
            }, {
                jsonrpc: "2.0",
                id: "1",
                method: "getMultipleAccounts",
                params: [
                    userPositions,
                  {
                    commitment: "processed",
                  },
                ],
            }]).then(response => {
                const userAccounts = response.data[0]
                const userPositionAccounts = response.data[1]

                const mappedUserAccounts = userAccounts.result.value.map(u =>  {
                    const raw: string = u.data[0];
                    const dataType = u.data[1]
                    const buffer = Buffer.from(raw, dataType);
                    return clearingHouse.program.account['user'].coder.accounts.decode(
                        // @ts-ignore
                        clearingHouse.program.account['user']._idlAccount.name, 
                        buffer
                    ) as UserAccount
                })
                
                const mappedUserPositionAccounts = userPositionAccounts.result.value.map(p => {
                    const raw: string = p.data[0];
                    const dataType = p.data[1]
                    const buffer = Buffer.from(raw, dataType);
                    return clearingHouse.program.account[
                        'userPositions'
                    ].coder.accounts.decode(
                        // @ts-ignore
                        clearingHouse.program.account['userPositions']._idlAccount.name,
                        buffer
                    ) as UserPositionsAccount
                })
                

                Promise.all(userArray.map(async (u, i) => {
                    let user = {
                        ...u,
                        accountData: mappedUserAccounts[i],
                        positionsAccountData: mappedUserPositionAccounts[i],
                        positions: mappedUserAccounts[i].positions.toBase58()
                    }

                    user.marginRatio = getMarginRatio(clearingHouse, user);
                    userMap.set(user.publicKey, user);
                    await sortUser(clearingHouse, userMap, accountSubscriberBucketMap, user)
                }))
            });
            
        })
    }))
}



let usersToSetup = [];
let setupUsersTimeout = null
const setupUser = async (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, u : User, tpuConnection: TpuConnection) => {
    if (!usersToSetup.includes(u)) {
        usersToSetup.push(u);
    }
    clearTimeout(setupUsersTimeout)
    setupUsersTimeout = setTimeout(() => {
        console.log('setting up users');
        setupUsers(clearingHouse, userMap, accountSubscriberBucketMap, usersToSetup, tpuConnection).then(() => {
            usersToSetup = [];
            [...accountSubscriberBucketMap.keys()].forEach(key => accountSubscriberBucketMap.get(key).subscribe());
        });
    }, 5000)
}

// prepare variables for liquidation loop
// let intervalCount = 0
// let numUsersChecked = new Array<number>();
// let checkTime = new Array<number>();

const getUsers = (clearingHouse: ClearingHouse, userMap: Map<string, User>, accountSubscriberBucketMap: Map<Priority, PollingAccountSubscriber>, tpuConnection: TpuConnection) => {
    if (fs.pathExistsSync('./storage/programUserAccounts')) {
        let usersFromFile = fs.readFileSync('./storage/programUserAccounts', "utf8");
        (JSON.parse(atob(usersFromFile)) as Array<{ publicKey: string, authority: string, positions: string }>).forEach(async user => {
            if (!userMap.has(user.publicKey))
                setupUser(clearingHouse, userMap, accountSubscriberBucketMap, user as User, tpuConnection)
        })
    } else {
        console.error('storage/programUserAccounts doesn\'t exist.... if the file is there and isn\'t empty, just start the bot again!')
        console.error('try using "npm run getUsers" before running the bot')
        process.exit();
    }
}

const main = async () => {
    const tpuConnection = await TpuConnection.load(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 60 * 1000 } as ConnectionConfig );
    const clearingHouse = _.createClearingHouse(tpuConnection)
    await clearingHouse.subscribe();

    const accountSubscriberBucketMap : Map<Priority, PollingAccountSubscriber> = new Map<Priority, PollingAccountSubscriber>();
    const userMap : Map<string, User> = new Map<string, User>();

    const lowPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, 0, 5 * 60 * 1000);
    accountSubscriberBucketMap.set(Priority.low, lowPriorityBucket)

    const mediumPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, 0, 60 * 1000);
    accountSubscriberBucketMap.set(Priority.medium, mediumPriorityBucket)

    const highPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, 0, 30 * 1000);
    accountSubscriberBucketMap.set(Priority.high, highPriorityBucket)
    

    setInterval(() => {
        getUsers(clearingHouse, userMap, accountSubscriberBucketMap, tpuConnection)
    }, 60 * 1000)

    setInterval(() => {
        sortUsers(clearingHouse, userMap, accountSubscriberBucketMap);
    }, (10 * 1000));


    setInterval(() => {
        checkBucket(clearingHouse, userMap, highPriorityBucket, tpuConnection)
        // intervalCount++;
    }, highPrioCheckUsersEveryMS);

    setInterval(() => {
        checkBucket(clearingHouse, userMap, mediumPriorityBucket, tpuConnection)
        // intervalCount++;
    }, mediumPrioCheckUsersEveryMS);

    setInterval(() => {
        checkBucket(clearingHouse, userMap, lowPriorityBucket, tpuConnection)
        // intervalCount++;
    }, lowPrioCheckUsersEveryMS);


    setInterval(() => {
        console.clear();
        console.log(`total mem usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`)
        console.log(`low: ${lowPriorityBucket.getAllKeys().length}, medium: ${mediumPriorityBucket.getAllKeys().length}, high: ${highPriorityBucket.getAllKeys().length}`)
    }, 1000 * 5)


    // setInterval(() => {
    //     const x = {
    //         ts: Date.now(),
    //         data: {
    //             userCount: userMap.size,
    //             prio: {
    //                 high: highPriorityBucket.getAllKeys().length,
    //                 medium: mediumPriorityBucket.getAllKeys().length,
    //                 low: lowPriorityBucket.getAllKeys().length
    //             },
    //             intervalCount: intervalCount,
    //             checked: numUsersChecked,
    //             margin: [...userMap.values()].map(u => u.marginRatio.toNumber()),
    //             time: checkTime
    //         }
    //     }


    //     intervalCount = 0
    //     numUsersChecked = new Array<number>();
    //     checkTime = new Array<number>();

    // }, 60 * 1000 * workerLoopTimeInMinutes);

};


main();

