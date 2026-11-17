import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE TABLE t (x INTEGER)");
const stmt = db.prepare("INSERT INTO t (x) VALUES (?)");
stmt.run(1);
stmt.run(2);
setTimeout(() => {}, 1500);
