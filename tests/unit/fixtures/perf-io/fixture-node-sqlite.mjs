import fs from "node:fs";

fs.readFileSync(process.argv[1]);
fs.readFileSync(process.argv[1]);
fs.readFileSync(process.argv[1]);

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (x INTEGER)");
const stmt = db.prepare("INSERT INTO t (x) VALUES (?)");
stmt.run(1);
stmt.run(2);

setTimeout(() => {}, 1500);
