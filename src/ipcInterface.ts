import { UserPosition, UserAccount } from '@drift-labs/sdk'
import BN from "bn.js"
import { PublicKey } from "@solana/web3.js"


// Convert from IPC To ClearingHouse


export interface IPC_UserPosition { 
    baseAssetAmount: string, // BN
    lastCumulativeFundingRate: string, // BN 
    marketIndex: string, // BN
    quoteAssetAmount: string // BN
}


export const convertUserPositionFromIPC = (ipcUserPosition : IPC_UserPosition) => {
    return {
        baseAssetAmount: new BN(ipcUserPosition.baseAssetAmount, 16),
        lastCumulativeFundingRate: new BN(ipcUserPosition.lastCumulativeFundingRate, 16),
        marketIndex: new BN(ipcUserPosition.marketIndex, 16),
        quoteAssetAmount: new BN(ipcUserPosition.quoteAssetAmount, 16)
    } as UserPosition
}

export interface IPC_UserAccount { 
    authority: string; // PublicKey
	collateral: string; // BN
	cumulativeDeposits: string; // BN
	positions: string; // PublicKey
	totalFeePaid: string; // BN
}

export const convertUserAccountFromIPC = (ipcUserAccount : IPC_UserAccount) => {
    return {
        authority: new PublicKey(ipcUserAccount.authority),
        collateral: new BN(ipcUserAccount.collateral, 16),
        cumulativeDeposits: new BN(ipcUserAccount.cumulativeDeposits, 16),
        positions: new PublicKey(ipcUserAccount.positions),
        totalFeePaid: new BN(ipcUserAccount.totalFeePaid, 16)
    } as UserAccount
}

// Convert from ClearingHouse to IPC

export const convertUserAccount = (userAccount: UserAccount) : IPC_UserAccount => {
    return {
        authority: userAccount.authority.toBase58(),
        collateral: userAccount.collateral.toJSON(),
        cumulativeDeposits: userAccount.cumulativeDeposits.toJSON(),
        positions: userAccount.positions.toBase58(),
        totalFeePaid: userAccount.totalFeePaid.toJSON()
    }
}

export const convertUserPosition = (position: UserPosition) : IPC_UserPosition => {
    return { 
        baseAssetAmount: position.baseAssetAmount.toJSON(),
        lastCumulativeFundingRate: position.lastCumulativeFundingRate.toJSON(),
        marketIndex: position.marketIndex.toJSON(),
        quoteAssetAmount: position.quoteAssetAmount.toJSON()
    }
}