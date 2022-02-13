# Lmvdzande's Liquidation Bot  
  
### This branch was used to test splitting the bot into threaded processes for best performance of the bot, but now has a singular process option as well.
### This branch includes TpuClient.ts (ported from solana rust lib) to send liquidation tx's straight to Tpu Leaders.
### This branch attemps to frontrun the liquidation by sending the tx's before the user is actually liquidatable to account for delay between sending the tx and checking the user's marign ratio on chain.

### the protocol-v1 is my fork [lmvdz/protocol-v1](https://github.com/lmvdz/protocol-v1/tree/barebones-polling-account)

### Checkout [Drift Protocol](https://docs.drift.trade/) for more information!

### Donations can be sent to my SOL address 8Ci5UbpoAFL5sAj4jeKwADceYrDxKQktXJnn1Vwgug5m

Quick Setup: 

```
$ git clone git@github.com:lmvdz/drift-liquidation-bot.git
$ cd drift-liquidation-bot
$ git checkout worker
$ git clone git@github.com:lmvdz/protocol-v1.git
$ cd protocol-v1
$ git checkout barebones-polling-account
$ cd ..
# setup the .env.local (information below)
$ touch .env.local


# install yarn if not already
$ npm install -g yarn

# linux
$ yarn rebuild

# windows
$ yarn rebuild-win

# both of these scripts should be run simultaneously, you can use pm2 to do that
$ yarn getUsers
# Currently better to run single
$ yarn start (multiple process) | yarn single (single process)

$ npm install -g pm2
$ pm2 start yarn --name "driftUsers" -- getUsers
$ pm2 start yarn --name "drift" -- start | pm2 start yarn --name "drift" -- single
$ pm2 list
$ pm2 logs
```

(multiple process)

By using child_process to split the work of ( getting users / subscribing / polling ) and (checking for liquidation of users based on position data) the bot is able to produce less bottlenecking a single process. This can allow multiple processes to run simultaneously. This costs significantly more RAM.


(single process)

With GenesysGo adding rate limits to their previously unlimited TPS RPC, I was forced to revert back to a single process.
Restrictions for GG currently is 10 tps per IP.

  
Create a `.env.local` file in the root of the project.  
The bot will look for the `BOT_KEY` and `RPC_URL` variable in the environment file.  
The `BOT_KEY` can either be a Uint8Array (solana-keygen) or base_58 encoded private key (phantom wallet export).  
The `RPC_URL` should point to your rpc of choice.

There are some config variables you can configure near the top of `index.ts`.  

```
// CONFIG THE BOT

// how many minutes before users will be fetched from storage
// the getUsersLoop.ts script will update the storage every minute
const userUpdateTimeInMinutes = 2

// how many minutes is considered one loop for the worker
// console will be cleared and new table/chart data will be displayed
const workerLoopTimeInMinutes = 1

// update all margin ratios every X minutes
const updateAllMarginRatiosInMinutes = 1


// check priority every X ms
const highPrioCheckUsersEveryMS = 5
const mediumPrioCheckUsersEveryMS = 1000
const lowPrioCheckUsersEveryMS = 5 * 1000


// the slippage of partial liquidation as a percentage --- 1 = 1% = 0.01 when margin ratio reaches 625 * 1.12 = (700)
// essentially trying to frontrun the transaction
const partialLiquidationSlippage = 0

// the margin ratio which determines which priority bucket the user will be a part of 
const highPriorityMarginRatio = 1000
const mediumPriorityMarginRatio = 2000

// how many instances of the worker.ts script will there be
const workerCount = 7;

// split the amount of users up into equal amounts for each worker
const splitUsersBetweenWorkers = true
```

  

Most of the code was documented, then I did a lot of changes to adapt to the environment. This bot was killing it on the liquidations, then the solana network was taking massive load and my bot would just crash on the GG RPC Network from my home setup.

Since then I've implemented a TPU Client (ported from the rust solana::tpu_client)
Built a custom User Account Polling solution, similiar to what is currently on the protocol-v1 orders branch.

The bot is optimized to check buckets of users based on their margin_ratio.
Users with margin_ratio' closer to being partially liquidated are assigned to a higher priority bucket, which increases time spent checking those important users, increasing the odds of your liquidator being the winner.

If you have questions, find me in the Drift Protocol discord: https://discord.gg/uDNCH9QC `@lmvdzande#0001`

Next two pictures are from `yarn start`

![image](https://user-images.githubusercontent.com/2179775/147393973-71ee8d39-6935-4414-94c4-a5d20f135698.png)
![image](https://user-images.githubusercontent.com/2179775/147394054-b855484c-f086-4538-82ea-f9cfed6bbae0.png)

Next picture is from `yarn single`

![image](https://user-images.githubusercontent.com/2179775/153732700-00503025-1a01-4163-8568-697869e826da.png)



