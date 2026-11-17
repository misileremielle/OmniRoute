import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./worker-target.mjs", import.meta.url));
await new Promise((resolve, reject) => {
  worker.on("error", reject);
  worker.on("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`worker exited with ${code}`));
  });
});
setTimeout(() => {}, 1500);
