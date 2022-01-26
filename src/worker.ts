import { default as _ } from './clearingHouse.js'

// solana web3
import {Connection, PublicKey, TransactionResponse } from '@solana/web3.js'
import bs58 from 'bs58';
// used for drift sdk
import {
    BN_MAX,
    calculateBaseAssetValue,
    calculatePositionFundingPNL,
    ClearingHouse,
    ClearingHouseUser,
    Market,
    PARTIAL_LIQUIDATION_RATIO,
    PRICE_TO_QUOTE_PRECISION,
    TEN_THOUSAND,
    UserAccount,
    UserPosition,
    ZERO,
    BN
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
// const workerIndex = parseInt(args[1])
const uuid = args[2]


// CONFIG THE LOOP TAKEN FROM THE ARGUMENTS SUPPLIED FROM INDEX.TS

// worker loop time in minutes
const workerLoopTimeInMinutes = parseFloat(args[3])

// update the liquidation distance of all users every X minutes, must be lower than the liquidationLoopTimeInMinutes otherwise won't be called
const updateAllMarginRatiosInMinutes = parseFloat(args[4])

// check users for liquidation every X milliseconds
const checkUsersEveryMS = parseFloat(args[5])

// only check users who's liquidation distance is less than X
// liquidation distance is calculated using the calcDistanceToLiq function
// (margin_ratio / (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 )))) + (margin_ratio % (partial_liquidation_ratio * ( 1 + (partialLiquidationSlippage / 100 ))))
// 1 corresponds to liquidatable
// anything greater than 1 is no liquidatable
// a value of 10 will mean all the users with margin_ratios less than 10 times the value of the partial_liquidation_ratio will be checked
// 625 is the partial_liquidation_ratio, so a value of 10 will mean users with margin_ratios less than 6250
// adding on the slipage of 4 % will make the partial_liquidation_ratio 650, so a value of 10 will mean users with margin_ratios less than 6500
const minLiquidationDistance = parseFloat(args[6]); // currently not used, all users are checked each call!

// the slippage of partial liquidation as a percentage
const partialLiquidationSlippage = parseFloat(args[7])


interface User {
    account: UserAccount,
    positions: Array<UserPosition>,
    eventListeners: Array<EventListener>
}

const users : Map<string, ClearingHouseUser> = new Map<string, ClearingHouseUser>();
const preparedLiquidationInstructions : Map<string, TransactionInstruction>= new Map<string, TransactionInstruction>();
const marginRatios : Map<string, BN> = new Map<string, BN>();

const workerConnection = new Connection(process.env.RPC_URL)
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

const liquidate = (clearingHouse: ClearingHouse, pub : PublicKey) : Promise<string> => {
    return new Promise(async (resolve, reject) => {
        let instruction = preparedLiquidationInstructions.get(pub.toBase58());
        if (instruction === undefined) {
            instruction = await prepareLiquidationIX(clearingHouse, pub)
        }
        let tx = wrapInTx(instruction)
        tx.recentBlockhash = (await clearingHouse.connection.getRecentBlockhash()).blockhash;
        tx.feePayer = clearingHouse.wallet.publicKey
        tx = await clearingHouse.wallet.signTransaction(tx)
        // const txId = await tpuClient.sendRawTransaction(tx.serialize())
        process.send(JSON.stringify({ type: 'tx', rawTransaction: tx.serialize(), pub: pub.toString() }));
        resolve(bs58.encode(tx.signature));
    })
    
}

const prepareUserLiquidationIX = (clearingHouse: ClearingHouse, user: ClearingHouseUser) => {
    user.getUserAccountPublicKey().then(pub => prepareLiquidationIX(clearingHouse, pub))
}

const prepareLiquidationIX = (clearingHouse: ClearingHouse, pub : PublicKey) : Promise<TransactionInstruction> => {
    return new Promise((resolve) => {
        clearingHouse.getLiquidateIx(pub).then( (instruction: TransactionInstruction) => {
            // console.error(instruction)
            preparedLiquidationInstructions.set(pub.toBase58(), instruction);
            resolve(instruction);
        })
    })
    
}
// if the margin ratio is less than the liquidation ratio just return 1 to move it to the front of the liquidation distance array
// divide the margin ratio by the partial liquidation ratio to get the distance to liquidation for the user
// use div and mod to get the decimal values

const slipLiq = PARTIAL_LIQUIDATION_RATIO.mul(new BN((1 + (partialLiquidationSlippage/100))))


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

const getMarginRatio = (pub: string) => {
    const user = users.get(pub)
    const positions = user.getUserPositionsAccount().positions;

    if (positions.length === 0) {
        return BN_MAX;
    }

    let totalPositionValue = ZERO, unrealizedPNL = ZERO

    positions.forEach(position => {
        const market = clearingHouse.getMarket(position.marketIndex);
        const baseAssetAmountValue = calculateBaseAssetValue(market, position);
        totalPositionValue = totalPositionValue.add(baseAssetAmountValue);
        unrealizedPNL = unrealizedPNL.add(calculatePositionPNL(market, position, baseAssetAmountValue, true));
    })

    unrealizedPnLMap.set(pub, unrealizedPNL.toString());

    if (totalPositionValue.eq(ZERO)) {
        return BN_MAX;
    }

    return (
        user.getUserAccount().collateral.add(unrealizedPNL) ??
        ZERO
    ).mul(TEN_THOUSAND).div(totalPositionValue);
}





const prioSet : Map<string, NodeJS.Timer> = new Map<string, NodeJS.Timer>();

const check = (pub : string) => {
    const marginRatio = getMarginRatio(pub)
    if (marginRatio.lte(slipLiq)) {
        liquidate(clearingHouse, new PublicKey(pub))
        if (process.send) process.send( JSON.stringify({ type: 'out', data: 'liq attempt ' + pub + ' ' + marginRatio.toNumber()/100 }));
    }
    marginRatios.set(pub, marginRatio)
}

const checkUser = (pub : string) : Promise<{pub: string, marginRatio: BN, closeToLiquidation: boolean}> => {
    return new Promise((resolve) => {
        const marginRatio = getMarginRatio(pub)
        const closeToLiquidation = marginRatio.lte(slipLiq)
        if (closeToLiquidation) {
            if (process.send) process.send( JSON.stringify({ type: 'out', data: pub + ' close to liq ' + marginRatio.toNumber()/100 }));
            if (!prioSet.has(pub)) {
                prioSet.set(pub, setInterval(() => {
                    check(pub)
                }));
            } else if (!closeToLiquidation) {
                clearInterval(prioSet.get(pub))
                prioSet.delete(pub)
            }
        }
        marginRatios.set(pub, marginRatio)
        resolve({pub, marginRatio, closeToLiquidation})
    })
    
}

const mapFilteredToLiquidationCheck = () : Array<Promise<{pub: string, marginRatio: BN, closeToLiquidation: boolean}>> => {
    return [...marginRatios].map(([publicKey,]) : Promise<{pub: string, marginRatio: BN, closeToLiquidation: boolean}> => { 
        return new Promise((innerResolve) => {
            checkUser(publicKey).then(({ pub, marginRatio, closeToLiquidation}) => innerResolve({ pub, marginRatio, closeToLiquidation}))
        })
    })
}

let marginRatioMap : Map<string, number> = new Map<string, number>();

// based on liquidation distance check users for liquidation
const checkUsersForLiquidation = () : Promise<{ numOfUsersChecked: number, time: [number, number] }> => {
    return new Promise(resolve => {
        var hrstart = process.hrtime();
        const filtered = mapFilteredToLiquidationCheck()
        Promise.all(filtered).then((promises) => {
            promises.forEach(p => {
                if (p.closeToLiquidation) {
                    marginRatioMap.set(p.pub, p.marginRatio.toNumber())
                } else {
                    marginRatioMap.delete(p.pub)
                }
            })
            resolve({numOfUsersChecked: filtered.length, time: process.hrtime(hrstart) })
        })
    })
}


const updateAllMarginRatios = () : Promise<[number, number]> => {
    return new Promise((resolve) => {
        var hrstart = process.hrtime();
        Promise.all([...users.keys()].map((publicKey) : Promise<void> => new Promise(resolveInner => {
            let mr = getMarginRatio(publicKey);
            if (mr.lte(slipLiq)) {
                marginRatioMap.set(publicKey, mr.toNumber())
            } else if (marginRatioMap.has(publicKey)) {
                marginRatioMap.delete(publicKey)
            }
            marginRatios.set(publicKey, mr)
            resolveInner();
        }))).then(() => {
            resolve(process.hrtime(hrstart));
        })
    })
    
}


// prepare variables for liquidation loop
let intervalCount = 0
let numUsersChecked = new Array<number>();
let checkTime = new Array<number>();
let startWorkerTryCount = 0;
// liquidation bot, where the magic happens
const startWorker = () => {
    if (startWorkerTryCount > 10) {
        process.exit();
    }
    startWorkerTryCount++;
    (async () => {
        if (!clearingHouse.isSubscribed) {
            await clearingHouse.subscribe()
            startWorker()
        } else {
            setInterval(() => {
                updateAllMarginRatios()
            }, (60 * 1000 * updateAllMarginRatiosInMinutes))
            setInterval(() => {
                checkUsersForLiquidation().then(({ numOfUsersChecked, time }) => {
                    intervalCount++
                    // console.log(intervalCount, numOfUsersChecked)
                    numUsersChecked.push(Number(numOfUsersChecked))
                    checkTime.push(Number(time[0] * 1000) + Number(time[1] / 1000000))
                })
            }, checkUsersEveryMS)
            setInterval(() => {
                const x = {
                    ts: Date.now(),
                    worker: uuid,
                    data: {
                        userCount: users.size,
                        intervalCount: intervalCount,
                        checked: numUsersChecked,
                        margin: [...marginRatioMap.values()],
                        time: checkTime,
                        unrealizedPnLMap: JSON.stringify([...unrealizedPnLMap])
                    }
                }
                // console.log(JSON.stringify(x))
                if (process.send) process.send( JSON.stringify({ type: 'data', data: x }));
        
                intervalCount = 0
                numUsersChecked = new Array<number>();
                checkTime = new Array<number>();
                marginRatioMap = new Map<string, number>();
            }, 60 * 1000 * workerLoopTimeInMinutes)
        }
        
    })();
}

const processMessage = (data : MessageData) => {
    if (data.dataSource === 'user') {
        if (data.programUserAccount !== undefined && data.programUserAccount !== null) {
            if (users.get(data.programUserAccount.publicKey) === undefined || users.get(data.programUserAccount.publicKey) === null) {
                const user = ClearingHouseUser.from(
                    clearingHouse,
                    new PublicKey(data.programUserAccount.authority)
                );
                if (!user.isSubscribed) {
                    user.subscribe().then(() => {

                        users.set(data.programUserAccount.publicKey, user);
                        if (user.getUserPositionsAccount().positions.length > 0) {
                            prepareUserLiquidationIX(clearingHouse, user)
                        }
                        marginRatios.set(data.programUserAccount.publicKey, getMarginRatio(data.programUserAccount.publicKey));
    
                        user.accountSubscriber.eventEmitter.on('userPositionsData', () => {
                            prepareUserLiquidationIX(clearingHouse, user)
                            marginRatios.set(data.programUserAccount.publicKey, getMarginRatio(data.programUserAccount.publicKey));
                        })
                        
                    })
                }
            }
        }
    } else if (data.dataSource === 'tx') {
        if (data.transaction.failed) {
            prepareLiquidationIX(clearingHouse, new PublicKey(data.transaction.pub))
        } else {
            getLiqTransactionProfit(data.transaction.signature).then((balanceChange : number) => {
                if (process.send) process.send( JSON.stringify( { type: 'error', data: `${new Date()} - Liquidated ${data.transaction.pub} Tx: ${data.transaction.signature} --- +${balanceChange.toFixed(2)} USDC` } ))
            })
        }
        
    }
}

interface MessageData {
    dataSource: string,
    programUserAccount: {publicKey: string, authority: string}
    transaction: { signature: string, failed: boolean, pub: string }
}

process.on('message', (data : MessageData) => {
    // console.error(data);
    processMessage(data)
});


clearingHouse = _.createClearingHouse(workerConnection)
startWorker()


if (process.send) process.send( JSON.stringify({type: 'started' }));
