// Step-11 fix 3: six indexes on call_logs and usage_history that no production query seeks with
// are dropped on every boot, after migrations (which still create them). The provider/timestamp
// one is dropped only while its wider replacement exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteAdapter } from "../../../src/lib/db/adapters/types.ts";
import { openMemorySqliteAdapter } from "../_helpers/memorySqliteAdapter.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-unused-log-indexes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const { dropUnusedLogIndexes } = await import("../../../src/lib/db/schemaColumns.ts");

const DROPPED = [
  "idx_cl_client_session_id",
  "idx_cl_provider_timestamp",
  "idx_uh_service_tier",
  "idx_uh_combo_strategy",
  "idx_uh_endpoint",
  "idx_uh_model",
];

const indexNames = (db: Pick<SqliteAdapter, "prepare">) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a booted file database has none of the six, and keeps the wider indexes", () => {
  const db = core.getDbInstance();
  const names = indexNames(db);
  for (const name of DROPPED) assert.ok(!names.includes(name), `${name} is dropped at boot`);
  for (const kept of [
    "idx_cl_health_matrix_cover",
    "idx_uh_provider_model_timestamp",
    "idx_uh_connection_timestamp",
    "idx_uh_dedup",
  ]) {
    assert.ok(names.includes(kept), `${kept} is kept`);
  }
});

test("a reboot over a database that has them again drops them again", () => {
  const db = core.getDbInstance();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_uh_model ON usage_history(model);
    CREATE INDEX IF NOT EXISTS idx_uh_endpoint ON usage_history(endpoint);
    CREATE INDEX IF NOT EXISTS idx_cl_provider_timestamp ON call_logs(provider, timestamp);
  `);
  core.resetDbInstance();
  const names = indexNames(core.getDbInstance());
  for (const name of DROPPED) assert.ok(!names.includes(name), `${name} is dropped on reboot`);
});

function openLogTables(withCover: boolean): SqliteAdapter {
  const db = openMemorySqliteAdapter();
  db.exec(`
    CREATE TABLE call_logs (id TEXT PRIMARY KEY, provider TEXT, timestamp TEXT,
      client_session_id TEXT, connection_id TEXT);
    CREATE TABLE usage_history (id INTEGER PRIMARY KEY, model TEXT, endpoint TEXT,
      service_tier TEXT, combo_strategy TEXT);
    CREATE INDEX idx_cl_client_session_id ON call_logs(client_session_id);
    CREATE INDEX idx_cl_provider_timestamp ON call_logs(provider, timestamp);
    CREATE INDEX idx_uh_service_tier ON usage_history(service_tier);
    CREATE INDEX idx_uh_combo_strategy ON usage_history(combo_strategy);
    CREATE INDEX idx_uh_endpoint ON usage_history(endpoint);
    CREATE INDEX idx_uh_model ON usage_history(model);
  `);
  if (withCover) {
    db.exec(
      "CREATE INDEX idx_cl_health_matrix_cover ON call_logs(provider, timestamp, connection_id)"
    );
  }
  return db;
}

test("the provider/timestamp index stays while its wider replacement is missing", () => {
  const db = openLogTables(false);
  try {
    dropUnusedLogIndexes(db);
    assert.deepEqual(
      indexNames(db).filter((n) => DROPPED.includes(n)),
      ["idx_cl_provider_timestamp"]
    );
  } finally {
    db.close();
  }
});

test("with the replacement present all six go; a second run is a no-op", () => {
  const db = openLogTables(true);
  try {
    dropUnusedLogIndexes(db);
    assert.deepEqual(
      indexNames(db).filter((n) => DROPPED.includes(n)),
      []
    );
    dropUnusedLogIndexes(db);
    assert.ok(indexNames(db).includes("idx_cl_health_matrix_cover"));
  } finally {
    db.close();
  }
});

test("one failing drop does not keep the others", () => {
  const db = openLogTables(true);
  const exec = db.exec.bind(db);
  const failing = "idx_uh_service_tier";
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    (db as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (sql.includes(failing)) throw new Error("database is locked");
      exec(sql);
    };
    dropUnusedLogIndexes(db);
    assert.deepEqual(
      indexNames(db).filter((n) => DROPPED.includes(n)),
      [failing],
      "only the failing one is left"
    );
    assert.ok(warnings.some((w) => w.includes(failing)));
  } finally {
    console.warn = originalWarn;
    db.close();
  }
});
