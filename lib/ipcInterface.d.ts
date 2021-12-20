import { UserPosition, UserAccount } from "@drift-labs/sdk";
export interface IPC_UserPosition {
    baseAssetAmount: string;
    lastCumulativeFundingRate: string;
    marketIndex: string;
    quoteAssetAmount: string;
}
export declare const convertUserPositionFromIPC: (ipcUserPosition: IPC_UserPosition) => UserPosition;
export interface IPC_UserAccount {
    authority: string;
    collateral: string;
    cumulativeDeposits: string;
    positions: string;
    totalFeePaid: string;
}
export declare const convertUserAccountFromIPC: (ipcUserAccount: IPC_UserAccount) => UserAccount;
export declare const convertUserAccount: (userAccount: UserAccount) => IPC_UserAccount;
export declare const convertUserPosition: (position: UserPosition) => IPC_UserPosition;
