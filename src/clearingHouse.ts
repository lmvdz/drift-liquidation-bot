// used to get environment variables
import { initialize, DriftEnv, ClearingHouse } from '@drift-labs/sdk';
import pkg from '@project-serum/anchor'
const {Provider, Wallet} = pkg
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { config } from 'dotenv';
import { from_b58 } from './util/base56.js';
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


//setup solana rpc connection
// the one provided is the best one as it allows for unlimited TPS
const mainnetConnection = new Connection("https://ssc-dao.genesysgo.net/")
const provider = new Provider(mainnetConnection, botWallet, Provider.defaultOptions());

//setup drift protocol
const sdkConfig = initialize({ env: 'mainnet-beta' as DriftEnv });
const clearingHouse = ClearingHouse.from(
    mainnetConnection,
    provider.wallet,
    new PublicKey(
        sdkConfig.CLEARING_HOUSE_PROGRAM_ID
    )
)

export default { clearingHouse, mainnetConnection }