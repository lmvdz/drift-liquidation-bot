import { LiquidationHistoryAccount } from '@drift-labs/sdk';
export interface Liquidation {
    ts: Date;
    partial: boolean;
    user: string;
    userAuthority: string;
    feeToLiquidator: number;
    liquidator: string;
    recordId: string;
}
export declare const asciichartColors: string[];
export declare const liquidatorMap: Map<string, Array<Liquidation>>;
export declare const print: (liquidatorMap: Map<string, Array<Liquidation>>, filter?: Array<string>) => void;
export declare const getLiquidationChart: (liquidatorMap: Map<string, Array<Liquidation>>, filter?: Array<string>) => string;
export declare const mapHistoryAccountToLiquidationsArray: (liquidationHistoryAccount: LiquidationHistoryAccount) => Array<Liquidation>;
export declare const updateLiquidatorMap: (liqMapped: Array<Liquidation>) => Map<string, Array<Liquidation>>;
export declare const getLiquidatorProfitTables: (liquidatorMap: Map<string, Array<Liquidation>>, filter?: Array<string>) => Array<any>;
