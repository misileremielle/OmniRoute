import fs from "node:fs";

fs.readFileSync(process.argv[1]);

setTimeout(() => {}, 1500);
