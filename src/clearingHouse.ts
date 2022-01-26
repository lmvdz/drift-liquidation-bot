// used to get environment variables
import { Wallet, initialize, DriftEnv, ClearingHouse, calculateEstimatedFundingRate, PythClient, BN } from '@drift-labs/sdk';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';

import { from_b58 } from './util/base56.js';

import { config } from 'dotenv';
config({path: './.env.local'});

const botKeyEnvVariable = "BOT_KEY"
// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
const botKey = process.env[botKeyEnvVariable]

if (botKey === undefined) {
    console.error('need a ' + botKeyEnvVariable +' env variable');
    process.exit()
}
// setup wallet
let keypair;

try {
    keypair = Keypair.fromSecretKey(
        from_b58(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")!
    );
} catch {
    try {
        keypair = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(botKey))
        );
    } catch {
        console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)')
        process.exit();
    }
}
const botWallet = new Wallet(keypair);

//setup drift protocol
const sdkConfig = initialize({ env: 'mainnet-beta' as DriftEnv });


//setup solana rpc connection
// the one provided is the best one as it allows for unlimited TPS
// const genesysgoConnection = new Connection(process.env.RPC_URL);
// const genesysgoConnection = new Connection("https://free.rpcpool.com");


const createClearingHouse = (connection : Connection ) : ClearingHouse => {
    return ClearingHouse.from(
        connection,
        botWallet,
        new PublicKey(
            sdkConfig.CLEARING_HOUSE_PROGRAM_ID
        )
    )
}



export default { createClearingHouse }