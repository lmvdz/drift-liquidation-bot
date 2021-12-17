# Lmvdzande's Liquidation Bot

Create a `.env.local` file in the root of the project.  
The bot will look for the `BOT_KEY` variable in the environment file.  
The `BOT_KEY` can either be a Uint8Array (solana-keygen) or base_58 encoded private key (phantom wallet export).  

There are some config variables you can configure.  

`liquidationLoopTimeInMinutes`  
`updateLiquidationDistanceInMinutes`  
`checkUsersInMS`  
`minLiquidationDistance`  

Most of the code is documented.  

The bot is optimized to only check to liquidate users who's margin_ratio is extremely close to being partially liquidated, which increases the speed at which the program can loop, increasing the odds of your liquidator being used as the matchmaker, threadripper, sniper, pimp, w/e you want to call it!

If you have questions, find me in the Drift Protocol discord: https://discord.gg/uDNCH9QC `@lmvdzande#0001`

