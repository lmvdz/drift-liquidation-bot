import { LocalStorage } from 'node-localstorage';
const localStorage = new LocalStorage('./storage');

import { ProgramAccount } from '@project-serum/anchor';

// used to convert from and to base64 respectively
import { btoa } from "./util/btoa.js"
import { atob } from "./util/atob.js"

import { default as _ } from './clearingHouse.js';
const programUserAccounts = localStorage.getItem('programUserAccounts')
_.genesysgoClearingHouse.program.account.user.all().then((newProgramUserAccounts: ProgramAccount<any>[]) => {
    if (programUserAccounts !== undefined && programUserAccounts !== null) {
        const existingUserAccounts = JSON.parse(atob(programUserAccounts)) as Array<{ publicKey: string, authority: string}>;
        let newlyAddedCount = 0
        newProgramUserAccounts.forEach((newUserAccount: ProgramAccount) => {
            if(!existingUserAccounts.some(userAccount => userAccount.publicKey === newUserAccount.publicKey.toBase58())) {
                existingUserAccounts.push({ publicKey: newUserAccount.publicKey.toBase58(), authority: newUserAccount.account.authority.toBase58()})
                newlyAddedCount++
            }
        })
        localStorage.setItem('programUserAccounts', btoa(JSON.stringify(existingUserAccounts)))
    } else {
        localStorage.setItem('programUserAccounts', btoa(JSON.stringify(newProgramUserAccounts.map(userAccount => ({ publicKey: userAccount.publicKey.toBase58(), authority: userAccount.account.authority.toBase58() })))))
    }
    console.log('done')
}).catch(error => {
    console.error(error)
});