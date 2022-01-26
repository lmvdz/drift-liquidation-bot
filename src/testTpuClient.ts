import { Account, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TpuClient } from "./tpuClient.js";
import { Token, TOKEN_PROGRAM_ID} from '@solana/spl-token';
import { config } from "dotenv";
import { from_b58, to_b58 } from './util/base56.js';
import { Wallet } from "@drift-labs/sdk";
import ts from "typescript";
import { fork } from 'child_process'

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
    const tpuClient = await TpuClient.load(new Connection('https://ssc-dao.genesysgo.net/'))
    
    const worker = fork('./src/testTpuWorker.ts', [])

    worker.on('message', (message: string) => {
        const data = JSON.parse(message)
        if (data.type === 'ts') {
            const tx = Transaction.from(Buffer.from(data.transaction));
            tpuClient.sendRawTransaction(tx.serialize()).then((txId) => {
                console.log(txId);
            })
        }
    })
    
    
})();
