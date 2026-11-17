import fs from "node:fs";

fs.statSync(process.argv[1]);
setTimeout(() => {}, 500);
