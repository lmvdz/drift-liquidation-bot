# Lmvdzande's Liquidation Bot  
  
### This branch is used to test splitting the bot into threaded processes for best performance of the bot  

### the protocol-v1 is my fork [lmvdz/protocol-v1](https://github.com/lmvdz/protocol-v1/tree/barebones-polling-account)

### Checkout [Drift Protocol](https://docs.drift.trade/) for more information!

### Donations can be sent to my SOL address 8Ci5UbpoAFL5sAj4jeKwADceYrDxKQktXJnn1Vwgug5m
  
By using child_process to split the work of (getting users / subscribing) and (checking for liquidation of users based on position data)  the bot is able to produce less bottlenecking of the single threaded nature of javascript.  

Currently the bot is hardcoded to run 80 workers at a time.  
Uses a lot of CPU at the start!  
CPU usage falls off after all the users are loaded/subscribed  
More workers = More RAM!!

  
Create a `.env.local` file in the root of the project.  
The bot will look for the `BOT_KEY` and `RPC_URL` variable in the environment file.  
The `BOT_KEY` can either be a Uint8Array (solana-keygen) or base_58 encoded private key (phantom wallet export).  
The `RPC_URL` should point to your rpc of choice.

There are some config variables you can configure near the top of `index.ts`.  

```
// CONFIG THE BOT

// how many minutes before users will be fetched from on chain ( get new users )
const userUpdateTimeInMinutes = 2

// how many minutes is considered one loop for the worker
const workerLoopTimeInMinutes = 1

// update all margin ratios every x minutes
const updateAllMarginRatiosInMinutes = 1

const highPrioCheckUsersEveryMS = 5
const mediumPrioCheckUsersEveryMS = 1000
const lowPrioCheckUsersEveryMS = 5 * 1000


// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.12 = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 0

const highPriorityMarginRatio = 1000
const mediumPriorityMarginRatio = 2000

// how many workers to check for users will there be
const workerCount = 7;

// split the amount of users up into equal amounts for each worker
const splitUsersBetweenWorkers = true
```

```
$ npm install


# This next command will run the user getter, I split it away from the main program because I was running multiple instances of the bot.
# This way it will only get the users once and each bot will check the storage file

$ npm run getUsers

$ npm run start
```

  

Most of the code was documented, then I did a lot of changes to adapt to the environment. This bot was killing it on the liquidations, then the solana network was taking massive load and my bot would just crash on the GG RPC Network from my home setup.

Since then I've implemented a TPU Client (ported from the rust solana::tpu_client)
Built a custom User Account Polling solution, similiar to what is currently on the protocol-v1 orders branch.

The bot is optimized to check buckets of users based on their margin_ratio.
Users with margin_ratio' closer to being partially liquidated are assigned to a higher priority bucket, which increases time spent checking those important users, increasing the odds of your liquidator being the winner.

If you have questions, find me in the Drift Protocol discord: https://discord.gg/uDNCH9QC `@lmvdzande#0001`

![image](https://user-images.githubusercontent.com/2179775/147393973-71ee8d39-6935-4414-94c4-a5d20f135698.png)
![image](https://user-images.githubusercontent.com/2179775/147394054-b855484c-f086-4538-82ea-f9cfed6bbae0.png)



