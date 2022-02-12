import { fork, ChildProcess } from 'child_process';



const workers : Map<string, ChildProcess> = new Map<string, ChildProcess>();





function createUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
     var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
     return v.toString(16);
  });
}

const startWorker = (file) => {
  const worker = fork(
    file,
    [], 
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc']}
  )
  const workerUUID = createUUID()
  workers.set(workerUUID, worker);


  if(worker.stderr)
  worker.stderr.on('data', (data : Buffer) => {
    console.log(data.toString());
  })

  worker.on('close', (code, sig) => {
      worker.kill();
      workers.delete(workerUUID)
      console.log('worked died')
      startWorker(file);
  })

  if(worker.stdout)
  worker.stdout.on('data', (data: Buffer) => {
      console.log(data.toString());
  })

  worker.on('message', (data : string) => {
    let d = JSON.parse(data);
    switch(d.type) {
      case 'started':
          break;
      case 'data':
          break;
      case 'out':
          if (d.isArray) {
            console.log(...d.data);
          } else {
            console.log(d.data);
          }
          break;
      case 'error':
          console.error(d.data);
          break;
    }
  })
}

startWorker('./src/getUsersLoop.ts')

for(let x = 0; x < 1; x++) {
    setTimeout(() => {
      startWorker('./src/index.ts');
    }, x * 2000)
}