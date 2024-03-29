import { ProgramAccount } from '@project-serum/anchor';

// used to convert from and to base64 respectively
import { btoa } from "./util/btoa.js"
import { atob } from "./util/atob.js"

import fs from 'fs-extra'

import { default as _ } from './clearingHouse.js';


import { config } from 'dotenv';
import { Connection, ConnectionConfig } from '@solana/web3.js';
import { UserAccount, UserOrdersAccount } from '@drift-labs/sdk';
config( {path: './.env.local'} );


const clearingHouse = _.createClearingHouse(new Connection(process.env.RPC_URL, { commitment: 'processed', confirmTransactionInitialTimeout: 1000 * 60 } as ConnectionConfig))
console.log(clearingHouse.program.programId.toBase58())
fs.ensureDirSync('./storage')
clearingHouse.program.account.user.all().then((newProgramUserAccounts: ProgramAccount<UserAccount>[]) => {
    fs.writeFileSync('./storage/programUserAccounts', btoa(JSON.stringify(newProgramUserAccounts.map(userAccount => ({ publicKey: userAccount.publicKey.toBase58(), authority: userAccount.account.authority.toBase58(), positions: userAccount.account.positions.toBase58() })))))
    // console.log(newProgramUserAccounts);
    // if (fs.pathExistsSync('./storage/programUserAccounts')) {
    //     const programUserAccounts = fs.readFileSync('./storage/programUserAccounts', 'utf8')
    //     const existingUserAccounts = JSON.parse(atob(programUserAccounts)) as Array<{ publicKey: string, authority: string}>;
    //     newProgramUserAccounts.forEach((newUserAccount: ProgramAccount<UserAccount>) => {
    //         if(!existingUserAccounts.some(userAccount => userAccount.publicKey === newUserAccount.publicKey.toBase58())) {
    //             existingUserAccounts.push({ publicKey: newUserAccount.publicKey.toBase58(), authority: newUserAccount.account.authority.toBase58()})
    //         }
    //     })
    //     fs.writeFileSync('./storage/programUserAccounts', btoa(JSON.stringify(existingUserAccounts)))
    // } else {
    // }
    console.log('done');
}).catch(error => {
    console.error(error)
});