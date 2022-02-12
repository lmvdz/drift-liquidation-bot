import { default as _ } from './clearingHouse.js'
import axios from 'axios';

// solana web3
import {Connection, ConnectionConfig, PublicKey, TransactionResponse, FetchMiddleware } from '@solana/web3.js'
import bs58 from 'bs58';
// used for drift sdk
import {
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
    UserPositionsAccount,
    getUserAccountPublicKey,
    getClearingHouseUser,
    getWebSocketClearingHouseUserConfig
} from '@drift-labs/sdk';



import { config } from 'dotenv';
config({path: './.env.local'});

// used to store the data, uses the same api calls as window.localStorage but works with nodejs
import { Transaction,TransactionInstruction } from '@solana/web3.js';

const wrapInTx = (instruction: TransactionInstruction) : Transaction  => {
	return new Transaction().add(instruction);
}
// const workerStorage = new LocalStorage('./storage/workers')

const args = process.argv.slice(2);

// const workerCount = parseInt(args[0])
const workerIndex = parseInt(args[1])
const uuid = args[2]

// CONFIG THE LOOP TAKEN FROM THE ARGUMENTS SUPPLIED FROM INDEX.TS

const workerLoopTimeInMinutes = parseFloat(args[3])

const highPrioCheckUsersEveryMS = parseFloat(args[4])

const mediumPrioCheckUsersEveryMS = parseFloat(args[5])

const lowPrioCheckUsersEveryMS = parseFloat(args[6])

const partialLiquidationSlippage = parseFloat(args[7])

const highPriorityMarginRatio = parseFloat(args[8])

const mediumPriorityMarginRatio = parseFloat(args[9])


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

// const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();
// const userKeys : Map<string, User> = new Map<string, User>();
// const preparedLiquidationInstructions : Map<string, TransactionInstruction>= new Map<string, TransactionInstruction>();
// const marginRatios : Map<string, BN> = new Map<string, BN>();

const workerConnection = new Connection(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 1000 * 60} as ConnectionConfig)
let clearingHouse : ClearingHouse = null;

const getLiqTransactionProfit = (tx:string) : Promise<number> => {
    return new Promise((resolve, reject) => {
        workerConnection.getTransaction(tx).then((transaction : TransactionResponse) => {
            if (transaction) {
                if (!transaction.meta.err) {
                    let clearingHouseUserPreTokenBalance : number = parseFloat(transaction.meta.preTokenBalances[0].uiTokenAmount.uiAmountString)
                    let clearingHouseUserPostTokenBalance : number = parseFloat(transaction.meta.postTokenBalances[0].uiTokenAmount.uiAmountString)
                    let balanceChange = clearingHouseUserPreTokenBalance - clearingHouseUserPostTokenBalance;
                    resolve(balanceChange)
                } else {
                    reject(transaction.meta.err)
                }
            } else {
                reject('transaction not found')
            }
        }).catch(error => {
            reject(error)
        })
    })
}

const liquidate = (user: User) : Promise<string> => {
    return new Promise(async (resolve, reject) => {
        let instruction = user.liquidationInstruction
        if (instruction === undefined) {
            instruction = await prepareUserLiquidationIX(user)
        }
        let tx = wrapInTx(instruction)
        tx.recentBlockhash = (await clearingHouse.connection.getRecentBlockhash()).blockhash;
        tx.feePayer = clearingHouse.wallet.publicKey
        tx = await clearingHouse.wallet.signTransaction(tx)
        process.send(JSON.stringify({ type: 'tx', rawTransaction: tx.serialize(), pub: user.publicKey }));
        resolve(bs58.encode(tx.signature));
    })
    
}

const prepareUserLiquidationIX = async (user: User) : Promise<TransactionInstruction> => {
    if (user.userAccountPublicKey === undefined || user.userAccountPublicKey === null)
    user.userAccountPublicKey = await getUserAccountPublicKey(clearingHouse.program.programId, new PublicKey(user.authority));
    // console.log('here')
    txSentCount++;
    userMap.set(user.publicKey, user);
    const liquidationInstruction = await prepareLiquidationIX(user.publicKey, user.userAccountPublicKey);
    return liquidationInstruction;
}

const prepareLiquidationIX = (userPub: string, userAccountPub : PublicKey) : Promise<TransactionInstruction> => {
    return new Promise((resolve) => {
        clearingHouse.getLiquidateIx(userAccountPub).then( (instruction: TransactionInstruction) => {
            // console.error(instruction)
            userMap.set(userPub, { ...userMap.get(userPub), liquidationInstruction: instruction });
            resolve(instruction);
        })
    })
    
}
// if the margin ratio is less than the liquidation ratio just return 1 to move it to the front of the liquidation distance array
// divide the margin ratio by the partial liquidation ratio to get the distance to liquidation for the user
// use div and mod to get the decimal values

const slipLiq = new BN(PARTIAL_LIQUIDATION_RATIO.toNumber() * (1 + (partialLiquidationSlippage/100)));


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


const unrealizedPnLMap : Map<string, string> = new Map<string, string>();

const getMarginRatio = (user: User) => {
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


const checkForLiquidation = (pub : string) => {    
    const user = userMap.get(pub)
    user.marginRatio = getMarginRatio(user);
    if (user.marginRatio.lte(slipLiq))
        liquidate(user);
}

const checkBucket = (bucket: PollingAccountSubscriber) => {
    const start = process.hrtime();
    const keys = bucket.getAllKeys();
    keys.forEach(async key => checkForLiquidation(key))
    numUsersChecked.push(keys.length)
    const time = process.hrtime(start);
    checkTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
}

// prepare variables for liquidation loop
let intervalCount = 0
let numUsersChecked = new Array<number>();
let checkTime = new Array<number>();
let startWorkerTryCount = 0;
// liquidation bot, where the magic happens
const startWorker = () => {
    try {
        if (startWorkerTryCount > 10) {
            process.exit();
        }
        startWorkerTryCount++;
        (async () => {
            if (!clearingHouse.isSubscribed) {
                await clearingHouse.subscribe();
                startWorker();
            } else {

                setInterval(() => {
                    sortUsers();
                }, (10 * 1000));


                setInterval(() => {
                    if (usersToSetup.length === 0)
                    checkBucket(highPriorityBucket)
                    intervalCount++;
                }, highPrioCheckUsersEveryMS);

                setInterval(() => {
                    if (usersToSetup.length === 0)
                    checkBucket(mediumPriorityBucket)
                    intervalCount++;
                }, mediumPrioCheckUsersEveryMS);

                setInterval(() => {
                    if (usersToSetup.length === 0)
                    checkBucket(lowPriorityBucket)
                    intervalCount++;
                }, lowPrioCheckUsersEveryMS);

                
                
                setInterval(() => {
                    const x = {
                        ts: Date.now(),
                        worker: uuid,
                        data: {
                            userCount: userMap.size,
                            prio: {
                                high: highPriorityBucket.getAllKeys().length,
                                medium: mediumPriorityBucket.getAllKeys().length,
                                low: lowPriorityBucket.getAllKeys().length
                            },
                            intervalCount: intervalCount,
                            checked: numUsersChecked,
                            margin: [...userMap.values()].map(u => u.marginRatio.toNumber()),
                            time: checkTime,
                            unrealizedPnLMap: JSON.stringify([...unrealizedPnLMap])
                        }
                    }
                    // console.log(JSON.stringify(x))
                    if (process.send) {
                        process.send( JSON.stringify({ type: 'data', data: x }) );
                        process.send( JSON.stringify({ type: 'memusage', usedMem: process.memoryUsage().heapUsed / 1024 / 1024 }) );
                    }
            
                    intervalCount = 0
                    numUsersChecked = new Array<number>();
                    checkTime = new Array<number>();

                }, 60 * 1000 * workerLoopTimeInMinutes);

                if (process.send) process.send( JSON.stringify({type: 'started' }));
            }
        })();
    } catch (error) {
        if (process.send) {
            process.send({ type: 'error', data: error })
        } else {
            console.error(error);
        }
    }
    
}

const processMessage = (data : MessageData) => {
    if (data.dataSource === 'user') {
        if (data.programUserAccount !== undefined && data.programUserAccount !== null) {
            if (!userMap.has(data.programUserAccount.publicKey)) {
                setupUser(data.programUserAccount as User)
            }
        }
    } else if (data.dataSource === 'tx') {
        if (data.transaction.failed) {
            sortUser(userMap.get(data.transaction.pub))
        }
    }
}

enum Priority {
    'high',
    'medium',
    'low'
}

const accountSubscriberBucketMap : Map<Priority, PollingAccountSubscriber> = new Map<Priority, PollingAccountSubscriber>();
const userMap : Map<string, User> = new Map<string, User>();

const getPrio = (user : User) => {
    return (user.marginRatio.lte(new BN(highPriorityMarginRatio)) ? Priority.high : (user.marginRatio.lte(new BN(mediumPriorityMarginRatio)) ? Priority.medium : Priority.low));
}

const sortUser = async (user: User) => {
    user.marginRatio = getMarginRatio(user);
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
            sortUser(newData);
        });

        accountSubscriberBucketMap.get(newPrio).addAccountToPoll(user.publicKey, 'userPositions', user.positions, async (data: UserPositionsAccount) => {
            // console.log(data);
            // console.log('updated user', 'positions data', user.publicKey)
            let oldData = userMap.get(user.publicKey);
            let newData = { ...oldData, positionsAccountData: data } as User;
            newData.marginRatio = getMarginRatio(newData);
            // newData.liquidationInstruction = await prepareUserLiquidationIX(newData);
            userMap.set(user.publicKey, newData);
            sortUser(newData);
        });

    }
}

const sortUsers = async () => {
    [...userMap.values()].forEach(async user => sortUser(user));
}

function sleep(milliseconds) {  
    return new Promise(resolve => setTimeout(resolve, milliseconds));  
}

function chunkArray(array : Array<any>, chunk_size : number) : Array<any> {
    return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
} 
let txSentCount = 0;

const setupUsers = async (users: Array<User>) => {
    let usersSetup = []
    let startTime = process.hrtime();
    usersSetup = chunkArray(await Promise.all(users.map(async (u, index) => {
        return {
            index,
            ...u
        }
    })), 100)

    await Promise.all(usersSetup.map(async (userArray, index) => {
        const userAccountKeys = userArray.map(u => u.publicKey)
        const userPositions = userArray.map(u => u.positions)
        sleep((index + 1) * 2000 * (workerIndex + 1)).then(() => {
            //@ts-ignore
            axios.post(workerConnection._rpcEndpoint, [{
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
                txSentCount++;
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

                    user.marginRatio = getMarginRatio(user);
                    // u.liquidationInstruction = await prepareUserLiquidationIX(u);
                    let endTime = process.hrtime(startTime);
                    // console.log(txSentCount + ' txs ', endTime[0] + ' seconds');
                    userMap.set(user.publicKey, user);
                    await sortUser(user)
                }))
            });
            
        })
    }))
}
let usersToSetup = [];
let setupUsersTimeout = null
const setupUser = async (u : User) => {
    if (!usersToSetup.includes(u)) {
        usersToSetup.push(u);
    }
    clearTimeout(setupUsersTimeout)
    setupUsersTimeout = setTimeout(() => {
        console.log('setting up users');
        setupUsers(usersToSetup).then(() => {
            usersToSetup = []
            lowPriorityBucket.subscribe();
            mediumPriorityBucket.subscribe();
            highPriorityBucket.subscribe();
        });
    }, 5000)
    // try {

    //     // const acc = await workerConnection.getMultipleAccountsInfo([new PublicKey('4tQB9kPyjQTB2v5Jso98d1EMwvN4jjNSXSrJQbqfEbQx')])
    //     // const userPositionsAccount  = clearingHouse.program.account[
    //     //     'userPositions'
    //     // ].coder.accounts.decode(
    //     //     // @ts-ignore
    //     //     clearingHouse.program.account['userPositions']._idlAccount.name,
    //     //     acc[0].data as Buffer
    //     // ) as UserPositionsAccount
    //     // console.log(userPositionsAccount);
    //     // // console.log(u)
    //     // const userAccountPub = await getUserAccountPublicKey(clearingHouse.program.programId, new PublicKey(u.authority));

    //     // //@ts-ignore
    //     // let rpcResponse = await clearingHouse.program.provider.connection._rpcRequest(
    //     //     'getMultipleAccounts',
    //     //     [[userAccountPub.toBase58()], { commitment: 'recent' }]
    //     // );

    //     // // console.log('here'); 
        
    //     // let raw: string = rpcResponse.result.value[0].data[0];
    //     // let dataType = rpcResponse.result.value[0].data[1];
    //     // let buffer = Buffer.from(raw, dataType);
        
    //     // const userAccount = clearingHouse.program.account[
    //     //     'user'
    //     // ].coder.accounts.decode(
    //     //     // @ts-ignore
    //     //     clearingHouse.program.account['user']._idlAccount.name,
    //     //     buffer
    //     // ) as UserAccount

    //     // // console.log(userAccount.positions.toBase58())
    //     // // console.log('here2'); 

    //     // //@ts-ignore
    //     // rpcResponse = await clearingHouse.program.provider.connection._rpcRequest(
    //     //     'getMultipleAccounts',
    //     //     [[userAccount.positions.toBase58()], { commitment: 'recent' }]
    //     // );

    //     // raw = rpcResponse.result.value[0].data[0];
    //     // dataType = rpcResponse.result.value[0].data[1];
    //     // buffer = Buffer.from(raw, dataType);

    //     // const userPositionsAccount  = clearingHouse.program.account[
    //     //     'userPositions'
    //     // ].coder.accounts.decode(
    //     //     // @ts-ignore
    //     //     clearingHouse.program.account['userPositions']._idlAccount.name,
    //     //     buffer
    //     // ) as UserPositionsAccount

    //     u = { ...u, accountData: userAccount, positionsAccountData: userPositionsAccount, accountPublicKey: userAccountPub.toBase58(), positions: userAccount.positions.toBase58()  }
        
    //     u.marginRatio = getMarginRatio(u);
    //     u.liquidationInstruction = await prepareUserLiquidationIX(u);
    //     userMap.set(u.publicKey, u);
    //     console.log('here')
    //     sortUser(u);
    // } catch (error) {
    //     // console.error(error, u)
    //     // setupUser(u)
    // }
}

interface MessageData {
    dataSource: string,
    programUserAccount: { publicKey: string, authority: string, positions: string }
    transaction: { signature: string, failed: boolean, pub: string }
}

process.on('message', (data : MessageData) => {
    // console.error(data);
    processMessage(data)
});

clearingHouse = _.createClearingHouse(workerConnection)

const lowPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, workerIndex, 60 * 1000);
accountSubscriberBucketMap.set(Priority.low, lowPriorityBucket)

const mediumPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, workerIndex, 30 * 1000);
accountSubscriberBucketMap.set(Priority.medium, mediumPriorityBucket)

const highPriorityBucket = new PollingAccountSubscriber(clearingHouse.program, workerIndex, 10 * 1000);
accountSubscriberBucketMap.set(Priority.high, highPriorityBucket)

const subAndStartWorker = () => {
    clearingHouse.subscribe().then((subscribed) => {
        if (subscribed) {
            startWorker()
        } else {
            subAndStartWorker();
        }
    })
}

subAndStartWorker();
