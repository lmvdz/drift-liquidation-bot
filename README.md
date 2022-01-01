# Lmvdzande's Liquidation Bot  
  
# This branch is used to test splitting the bot into threaded processes for best performance of the bot  

# Checkout (Drift Protocol)[https://docs.drift.trade/] for more information!
  
By using child_process to split the work of (getting users / subscribing) and (checking for liquidation of users based on position data)  the bot is able to produce less bottlenecking of the single threaded nature of javascript.  

Currently the bot is hardcoded to run 80 workers at a time.  
Uses a lot of CPU at the start!  
CPU usage falls off after all the users are loaded/subscribed  
More workers = More RAM  

  
Create a `.env.local` file in the root of the project.  
The bot will look for the `BOT_KEY` variable in the environment file.  
The `BOT_KEY` can either be a Uint8Array (solana-keygen) or base_58 encoded private key (phantom wallet export).  

There are some config variables you can configure near the top of `index.ts`.  

- how often to get new users from on chain  
`userUpdateTimeInMinutes`  

- how long is considered 1 loop for the worker
`workerLoopTimeInMinutes`

- how often the loop resets and checks for new users to subscribe to  
`liquidationLoopTimeInMinutes`  
  
- how often the loop checks all users' liquidation distance  
`updateAllMarginRatiosInMinutes`  
  
- how often to check for liquidatable users within minimum liquidation distance  
`checkUsersEveryMS`  
  
- min liquidation distance to consider  
`minLiquidationDistance`  
  
  
- partial liquidation slippage to account for the time it takes to send the transaction (frontrunning)  
- the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.12 = (700)  
`partialLiquidationSlippage`  
  
- number of workers, each worker will have an equal amount of users  
`workerCount`  

- whether or not to split the users into equal amounts for each worker  
- if this is false, and the worker count is greater than 1 than each worker will have a copy of all users  
`splitUsersBetweenWorkers`  


```
npm install
npm run start
```

  

Most of the code is documented.  

The bot is optimized to only check to liquidate users who's margin_ratio is extremely close to being partially liquidated, which increases the speed at which the program can loop, increasing the odds of your liquidator being used as the matchmaker, threadripper, sniper, pimp, w/e you want to call it!

If you have questions, find me in the Drift Protocol discord: https://discord.gg/uDNCH9QC `@lmvdzande#0001`

![image](https://user-images.githubusercontent.com/2179775/147393973-71ee8d39-6935-4414-94c4-a5d20f135698.png)
![image](https://user-images.githubusercontent.com/2179775/147394054-b855484c-f086-4538-82ea-f9cfed6bbae0.png)



