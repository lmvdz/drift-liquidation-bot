import { exec } from 'child_process';

setInterval(() => {
    exec("node --no-warnings --loader ts-node/esm ./src/getUsers.js", (error, stdout, stderr) => {
        if (stderr) {
            console.error(stderr)
        } else {
            console.log(new Date(Date.now()) + ' ' + stdout)
        }
    })
}, 1000 * 60)
