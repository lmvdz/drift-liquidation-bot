import { config } from "dotenv";
import { from_b58, to_b58 } from './util/base56.js';
import { Wallet } from "@drift-labs/sdk";
import { Account, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Token, TOKEN_PROGRAM_ID} from '@solana/spl-token';

config({path: './.env.local'});

const botKeyEnvVariable = "BOT_KEY"
// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
const botKey = process.env[botKeyEnvVariable]

if (botKey === undefined) {
    console.error('need a ' + botKeyEnvVariable +' env variable');
    process.exit()
}
// setup wallet
let keypair : Keypair;

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

;(async () => {
    const signer = new Account(keypair.secretKey)
    const tx = new Transaction().add(Token.createTransferInstruction(TOKEN_PROGRAM_ID, new PublicKey('GyBnwY1jZFkimEKh2fwbzDypnjmnj1hAANWdwG3Zw9iK'), new PublicKey('GyBnwY1jZFkimEKh2fwbzDypnjmnj1hAANWdwG3Zw9iK'), botWallet.publicKey, [signer], 1 * (10 ** 9)));
    tx.recentBlockhash = (await new Connection('https://ssc-dao.genesysgo.net/').getRecentBlockhash()).blockhash
    tx.sign(...[signer]);
    if (process.send) {
        process.send(JSON.stringify({ type: 'ts', transaction: tx.serialize() }))
    }
})();
