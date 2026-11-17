/**
 * Stage-2 T1 tests for scripts/perf/request-io-preload.mjs (node:test).
 *
 * Each test spawns a child `node --import <preload> <fixture>` with a fresh
 * temp PERF_IO_COUNTER_DIR. The --import flag takes the preload as a file URL
 * and the child env strips NODE_OPTIONS so the parent runner's tsx loader is
 * not inherited. Loader noise is entry-shape-dependent (entry realpathSync +
 * readFileSync; node:sqlite adds a third readFileSync; stdout redirection adds
 * writeSync), so where a counter's absolute value depends on that noise the
 * tests assert differentials against the idle baseline instead of exact values.
 * Exit codes come from spawnSync status so a failing child fails the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRELOAD = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "perf",
  "request-io-preload.mjs"
);
const FIXTURES = path.join(import.meta.dirname, "fixtures", "perf-io");
const PRELOAD_URL = pathToFileURL(PRELOAD).href;

interface SqliteDriverCounts {
  statements: number;
  prepare: number;
  exec: number;
}

interface SqliteCounts extends SqliteDriverCounts {
  byDriver: Record<string, SqliteDriverCounts>;
}

interface ReportCounts {
  sqlite: SqliteCounts;
  fsSync: Record<string, number>;
  fsAsync: Record<string, number>;
  fsCallback: Record<string, number>;
  workersCreated: number;
  driversHooked: string[];
  driversUsed: string[];
}

interface CounterReport {
  pid: number;
  ppid: number;
  threadId: number;
  isMainThread: boolean;
  argv: string[];
  role: string;
  counts: ReportCounts;
  writtenAt: number;
}

function fixturePath(name: string): string {
  return path.join(FIXTURES, `${name}.mjs`);
}

function childEnv(dir: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PERF_IO_COUNTER_DIR: dir,
    ...extraEnv,
  };
  // The parent test runner starts with NODE_OPTIONS=--import tsx/esm: a child
  // would otherwise inherit the tsx loader and break its own --import flags.
  delete env.NODE_OPTIONS;
  return env as NodeJS.ProcessEnv;
}

function spawnChild(name: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-io-"));
  const result = spawnSync(
    process.execPath,
    ["--import", PRELOAD_URL, ...extraArgs, fixturePath(name)],
    {
      env: childEnv(dir, extraEnv),
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `child ${name} exited with ${result.status}: ${result.stderr}`);
  return { dir };
}

interface LiveChild {
  dir: string;
  pid: number;
  done: Promise<{ status: number; stderr: string }>;
}

function spawnLiveChild(name: string, extraEnv: Record<string, string> = {}): LiveChild {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-io-"));
  const child = spawn(process.execPath, ["--import", PRELOAD_URL, fixturePath(name)], {
    env: childEnv(dir, extraEnv),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<{ status: number; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stderr: Buffer.concat(chunks).toString() });
    });
  });
  assert.ok(child.pid);
  return { dir, pid: child.pid as number, done };
}

function readReports(dir: string): CounterReport[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as CounterReport);
}

function mainReport(dir: string): CounterReport {
  const main = readReports(dir).filter((report) => report.threadId === 0);
  assert.equal(main.length, 1);
  const report = main[0];
  assert.ok(report);
  return report as CounterReport;
}

function zeroDriver(): SqliteDriverCounts {
  return { statements: 0, prepare: 0, exec: 0 };
}

function driverCounts(report: CounterReport, driver: string): SqliteDriverCounts {
  return report.counts.sqlite.byDriver[driver] ?? zeroDriver();
}

test("idle child: every counter is 0 and the file is rewritten while running", async () => {
  const { dir, pid, done } = spawnLiveChild("fixture-idle");
  const file = path.join(dir, `${pid}-0.json`);
  // The child runs 1.5 s with a 250 ms report interval: sample writtenAt
  // while it is alive and require at least 3 distinct values.
  const seen = new Set<number>();
  const deadline = Date.now() + 10000;
  let report: CounterReport | null = null;
  let first: CounterReport | null = null;
  while (seen.size < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (fs.existsSync(file)) {
      report = JSON.parse(fs.readFileSync(file, "utf8")) as CounterReport;
      first ??= report;
      seen.add(report.writtenAt);
    }
  }
  assert.ok(seen.size >= 3, `expected >= 3 distinct writtenAt values, saw ${seen.size}`);
  // Loading the entry module itself does fs work before the idle period; while
  // idle, the preload's own reporting must add nothing to any counter.
  assert.ok(first && report);
  assert.deepEqual(report.counts, first.counts, "counters changed while the child was idle");
  const { status, stderr } = await done;
  assert.equal(status, 0, `child fixture-idle exited with ${status}: ${stderr}`);
  assert.ok(report);
  assert.equal(report.counts.sqlite.statements, 0);
  assert.equal(report.counts.sqlite.prepare, 0);
  assert.equal(report.counts.sqlite.exec, 0);
  assert.deepEqual(report.counts.sqlite.byDriver, {});
  assert.deepEqual(report.counts.fsAsync, {});
  assert.deepEqual(report.counts.fsCallback, {});
  assert.equal(report.counts.workersCreated, 0);
  assert.deepEqual(report.counts.driversUsed, []);
  assert.deepEqual(report.counts.driversHooked, ["node:sqlite"]);
  // The last sample taken while the child was alive already has the final
  // zero counters (the fixture performs no I/O of its own).
  assert.ok(report.writtenAt > 0);
});

test("child with 3 readFileSync + node:sqlite prepare/run counts by driver", () => {
  const { dir } = spawnChild("fixture-node-sqlite");
  const report = mainReport(dir);
  const idle = mainReport(spawnChild("fixture-idle").dir);
  assert.equal(report.counts.fsSync.readFileSync, (idle.counts.fsSync.readFileSync ?? 0) + 3);
  assert.equal(report.counts.sqlite.prepare, 1);
  assert.equal(report.counts.sqlite.statements, 2);
  const byDriver = driverCounts(report, "node:sqlite");
  assert.equal(byDriver.prepare, 1);
  assert.equal(byDriver.statements, 2);
  assert.deepEqual(report.counts.driversUsed, ["node:sqlite"]);
});

test("better-sqlite3 child counts prepare 1, statements 2, exec 1 by driver", () => {
  const { dir } = spawnChild("fixture-better-sqlite3");
  const report = mainReport(dir);
  assert.equal(report.counts.sqlite.prepare, 1);
  assert.equal(report.counts.sqlite.statements, 2);
  assert.equal(report.counts.sqlite.exec, 1);
  const byDriver = driverCounts(report, "better-sqlite3");
  assert.equal(byDriver.prepare, 1);
  assert.equal(byDriver.statements, 2);
  assert.equal(byDriver.exec, 1);
  assert.ok(report.counts.driversHooked.includes("better-sqlite3"));
  assert.deepEqual(report.counts.driversUsed, ["better-sqlite3"]);
});

test("ESM named readFileSync import is counted twice", () => {
  const { dir } = spawnChild("fixture-esm-fs");
  const report = mainReport(dir);
  const idle = mainReport(spawnChild("fixture-idle").dir);
  assert.equal(report.counts.fsSync.readFileSync, (idle.counts.fsSync.readFileSync ?? 0) + 2);
});

test("--import given twice does not double counts", () => {
  // A query string makes a second, separate module instance, so this exercises
  // the globalThis guard rather than the ESM module cache. fixture-guard exits
  // non-zero unless exactly one instance patched the thread.
  const second = ["--import", `${PRELOAD_URL}?second`];
  spawnChild("fixture-guard", second);
  const { dir } = spawnChild("fixture-fs", second);
  const report = mainReport(dir);
  // Same flags for the baseline: loading the second instance is itself one read.
  const idle = mainReport(spawnChild("fixture-idle", second).dir);
  assert.equal(report.counts.fsSync.readFileSync, (idle.counts.fsSync.readFileSync ?? 0) + 1);
});

test("worker thread gets its own file; main file has workersCreated 1", () => {
  const { dir } = spawnChild("fixture-worker");
  const workers = readReports(dir).filter((report) => report.threadId !== 0);
  assert.ok(workers.length >= 1);
  const worker = workers[0];
  assert.ok(worker);
  assert.equal(worker.counts.fsSync.statSync, 1);
  const main = mainReport(dir);
  assert.equal(main.counts.workersCreated, 1);
});

test("callback-style fs calls are counted", () => {
  const { dir } = spawnChild("fixture-fs-callback");
  const report = mainReport(dir);
  assert.equal(report.counts.fsCallback.stat, 2);
  assert.equal(report.counts.fsCallback.readFile, 1);
});

test("wrapped fs functions keep their own properties and promisify behaviour", () => {
  const { dir } = spawnChild("fixture-fs-props");
  const report = mainReport(dir);
  // The fixture exits non-zero if realpathSync.native / realpath.native are
  // missing or promisify(fs.read) loses its { bytesRead, buffer } shape.
  assert.ok(report.counts.fsSync.realpathSync >= 1);
});

test("unset PERF_IO_COUNTER_DIR: no file is written and fs still works", () => {
  const env = { ...process.env };
  delete env.PERF_IO_COUNTER_DIR;
  const probe = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-io-unset-")),
    "probe.mjs"
  );
  fs.writeFileSync(
    probe,
    'import fs from "node:fs";\nfs.statSync(process.argv[1]);\nconsole.log("fs-ok");\n'
  );
  const result = spawnSync(process.execPath, ["--import", PRELOAD, probe], { env, timeout: 30000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /fs-ok/);
  assert.equal(fs.existsSync(path.join(path.dirname(probe), "counters")), false);
});
