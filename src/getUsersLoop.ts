import { exec } from 'child_process';

const getUsers = () => {
    exec("node --no-warnings --loader ts-node/esm ./src/getUsers.js", (error, stdout, stderr) => {
        if (stdout.includes('done')) {
            console.log(new Date(Date.now()) + ' done.');
        } else {
            console.error(stderr)
        }
    })
}

const loop = () => {
    getUsers()
    setInterval(() => {
        getUsers()
    }, 1000 * 60)
}



process.on('uncaughtException', (error) => {
    console.error(error)
});

loop();