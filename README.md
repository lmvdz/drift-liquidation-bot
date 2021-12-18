# Lmvdzande's Liquidation Bot  
  
# This branch is used to test splitting the bot into threaded processes for best performance of the bot  
  
By using child_process to split the work of (getting users / subscribing) and (checking for liquidation of users based on position data)  the bot is able to produce less bottlenecking of the single threaded nature of javascript.  

Currently the bot is hardcoded to run 10 workers at a time.  
  
Create a `.env.local` file in the root of the project.  
The bot will look for the `BOT_KEY` variable in the environment file.  
The `BOT_KEY` can either be a Uint8Array (solana-keygen) or base_58 encoded private key (phantom wallet export).  

There are some config variables you can configure.  

- how often the loop resets and checks for new users to subscribe to  
`liquidationLoopTimeInMinutes`  
  
- how often the loop checks all users' liquidation distance  
`updateLiquidationDistanceInMinutes`  
  
- how often to check for liquidatable users within minimum liquidation distance  
`checkUsersInMS`  
  
- min liquidation distance to consider  
`minLiquidationDistance`  
  

Most of the code is documented.  

The bot is optimized to only check to liquidate users who's margin_ratio is extremely close to being partially liquidated, which increases the speed at which the program can loop, increasing the odds of your liquidator being used as the matchmaker, threadripper, sniper, pimp, w/e you want to call it!

If you have questions, find me in the Drift Protocol discord: https://discord.gg/uDNCH9QC `@lmvdzande#0001`

