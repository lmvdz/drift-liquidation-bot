import { LiquidationHistoryAccount } from '@drift-labs/sdk';
import {table} from './util/table.js'
import  * as asciichart from 'asciichart'



export const asciichartColors = [
   "red",
   "green",
   "yellow",
   "blue",
   "magenta",
   "cyan",
   "lightgray",
   "darkgray",
   "lightred",
   "lightgreen",
   "lightyellow",
   "lightblue",
   "lightmagenta",
   "lightcyan",
   "white",
]



export interface Liquidation { 
    ts: Date,
    partial: boolean, 
    user: string, 
    userAuthority: string,
    feeToLiquidator: number,
    liquidator: string,
    recordId: string, 
    margin_ratio: number
}


export const mapHistoryAccountToLiquidationsArray = (liquidationHistoryAccount : LiquidationHistoryAccount) : Array<Liquidation> => {
    return liquidationHistoryAccount.liquidationRecords.map(liquidation => {
        return {
            recordId: liquidation.recordId.toString(),
            ts: new Date(liquidation.ts.toNumber() * 1000),
            partial: liquidation.partial, 
            user: liquidation.user.toBase58(), 
            userAuthority: liquidation.userAuthority.toBase58(),
            feeToLiquidator: (liquidation.feeToLiquidator.toNumber() / 1000000),
            liquidator: liquidation.liquidator.toBase58(),
            margin_ratio: liquidation.marginRatio.toNumber() / 100
        } as Liquidation
    });
}

export const updateLiquidatorMap = ( liqMapped: Array<Liquidation> ) : Map<string, Array<Liquidation>> => {
    const liquidatorMap : Map<string, Array<Liquidation>> = new Map<string, Array<Liquidation>>();
    liqMapped.forEach(liq => {
        let liquidations = liquidatorMap.get(liq.liquidator)
        if (liquidations === undefined) {
            liquidatorMap.set(liq.liquidator, new Array<Liquidation>(liq))
        } else {
            if (!liquidations.some(existingLiq => existingLiq.recordId === liq.recordId)) {
                liquidations.push(liq)
            }
            liquidatorMap.set(liq.liquidator, liquidations)
        }
    })
    return liquidatorMap
}

export const getLiquidatorProfitTables = (liquidatorMap : Map<string, Array<Liquidation>>, filter?: Array<string>) : Array<any> => {
    return [
        ([...liquidatorMap].filter(([liquidator, liquidations]) => {
            return liquidations.map(liquidation => liquidation.feeToLiquidator).reduce((a, b) => (a + b), 0) > 0
        }).map(([liquidator, liquidations]) => {
            return {
                liquidator,
                profit: liquidations.map(liquidation => liquidation.feeToLiquidator).reduce((a, b) => (a + b), 0)
            }
        }).sort((a, b) => b.profit - a.profit).map((data => {
            return {
                "Liquidator": data.liquidator,
                "Profit": data.profit + " USDC"
            }
        }))), 
        ([...liquidatorMap.values()].flat().sort((a, b) => {
            return b.ts.getTime() - a.ts.getTime()
        }).slice(0, 20).map(newest => {
            return {
                "Liquidator": newest.liquidator,
                "Profit": "+" +newest.feeToLiquidator + " USDC",
                "Timestmap": newest.ts.toLocaleDateString() + " " + newest.ts.toLocaleTimeString(),
                "Margin": newest.margin_ratio  + " %"
            }
        }))
    ];
}




export const print = (liquidatorMap : Map<string, Array<Liquidation>>, filter?: Array<string>) => {
    console.clear()
    getLiquidatorProfitTables(liquidatorMap, filter).forEach(tableData => {
        table(tableData);
    })
    console.log(getLiquidationChart(liquidatorMap, filter))
}

export const getLiquidationChart = (liquidatorMap : Map<string, Array<Liquidation>>, filter?: Array<string>) => {
    let firstLiquidation : Date = new Date();
    const liquidatorsWithLiquidations = [...liquidatorMap].filter(([liquidator, liquidations]) => {
        return liquidations.map(l => l.feeToLiquidator).reduce((a, b) => a + b, 0) > 0 && liquidator !== '72FwbpFGoLEazJEdpqNtPNefsadUrimUqma9wSoy4qiS'
    })
    // console.log(liquidatorsWithLiquidations)
    liquidatorsWithLiquidations.forEach(([liquidator, liquidations]) => {
        liquidations.forEach(l => {
            if (l.ts < firstLiquidation) {
                firstLiquidation = l.ts
            }
        })
    })
    let lastLiquidation = new Date(firstLiquidation.getTime())
    liquidatorsWithLiquidations.forEach(([liquidator, liquidations]) => {
        liquidations.forEach(l => {
            if (l.ts > lastLiquidation) {
                lastLiquidation = l.ts
            }
        })
    });
    let liquidatorCharts = {}
    const daysBetween = (lastLiquidation.getTime() - firstLiquidation.getTime()) / ( 1000 * 3600 * 7);
    for(let x = 0; x < daysBetween; x++) {
        let min = new Date(firstLiquidation.getTime() + (x * 1000 * 3600 * 7))
        let max = new Date(firstLiquidation.getTime() + ((x+1) * 1000 * 3600 * 7))
        // console.log(min, max)
        liquidatorsWithLiquidations.forEach(([liquidator, liquidations]) => {
            if (liquidatorCharts[liquidator] === undefined) {
                liquidatorCharts[liquidator] = []
            }
            let total = 0
            liquidations.forEach(l => {
                if (l.ts >= min && l.ts < max) {
                    total += l.feeToLiquidator
                }
            })
            liquidatorCharts[liquidator][x] = total + (x > 0 ? liquidatorCharts[liquidator][x - 1] : 0)
        });
    }
    // console.log(liquidatorCharts)
    let series = Object.keys(liquidatorCharts).filter(liq => ((filter !== undefined && filter !== null && filter.length > 0) ? filter.includes(liq) :  true)).map(liq => liquidatorCharts[liq]).sort((a, b) => b[b.length - 1] - a[a.length - 1])
    let colors = asciichartColors.slice(0, series.length).map(color => asciichart[color])
    // console.log(series, colors)
    // console.log(series)
    let text = ''
    series.forEach((chart, index) => {
        text += asciichart.plot(chart, {
            colors: [colors[index]],
            height: 3
        })
        if (index < series.length - 1) {
            text += '\n\n'
        }
    })
    return text;

    // console.log(asciichart.plot(series, {
    //     colors: colors,
    //     height: 6
    // }))
    

}