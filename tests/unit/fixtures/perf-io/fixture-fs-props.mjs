import fs from "node:fs";
import { promisify } from "node:util";

const target = process.argv[1];

if (typeof fs.realpathSync.native !== "function") process.exit(10);
if (typeof fs.realpath.native !== "function") process.exit(11);
fs.realpathSync(target);

const fd = fs.openSync(target, "r");
const result = await promisify(fs.read)(fd, Buffer.alloc(4), 0, 4, 0);
fs.closeSync(fd);
if (typeof result !== "object" || result === null || result.bytesRead !== 4) process.exit(12);
if (!Buffer.isBuffer(result.buffer)) process.exit(13);
