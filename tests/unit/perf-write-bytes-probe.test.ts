import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BATCH_SETTLE_MS,
  ProcTracker,
  REMOVED_ENV,
  SETTLE_MAX_MS,
  WAL_PASSIVE_INTERVAL_OFF_MS,
  artifactTime,
  checkpointComplete,
  checkpointInWindow,
  checkpointOnce,
  checkpointWithRetry,
  countWindowRows,
  dbReading,
  pacedInvalidReason,
  pacedStart,
  parseVmRssKb,
  rowCheck,
  rowsOk,
  settleState,
  walHeader,
  fsTypeFor,
  parseProcIo,
  parseProcStat,
  parseWritesArgs,
  readProc,
  scanProcForDataDir,
  sizeDeltas,
  stopAndRemove,
  windowArtifacts,
  windowDelta,
  type CheckpointAttempt,
  type DbReading,
  type ProcEntry,
  type Reading,
  type RowCounts,
  type SettingReport,
  type Tracked,
} from "../../scripts/perf/write-bytes-probe.ts";
import { DatabaseSync } from "node:sqlite";

const ARGS = [
  "--root",
  "/arm",
  "--label",
  "base-1",
  "--out",
  "/o/w.json",
  "--log",
  "/o/w.log",
  "--data-dir-d",
  "/h/perf-writes/s/base-1-D-a1",
  "--data-dir-l",
  "/h/perf-writes/s/base-1-L-a1",
  "--owner-token",
  "t0k",
];

test("parseWritesArgs: all flags required; folders absolute, normalized and distinct", () => {
  const a = parseWritesArgs(ARGS);
  assert.equal(a.dataDirL, "/h/perf-writes/s/base-1-L-a1");
  assert.throws(() => parseWritesArgs(ARGS.slice(0, -2)), /--owner-token is required/);
  const swap = (flag: string, v: string): string[] => {
    const out = [...ARGS];
    out[out.indexOf(flag) + 1] = v;
    return out;
  };
  assert.throws(() => parseWritesArgs(swap("--data-dir-d", "rel/x")), /absolute/);
  assert.throws(() => parseWritesArgs(swap("--data-dir-d", "/h/../x")), /normalized/);
  assert.throws(() => parseWritesArgs(swap("--data-dir-d", "/")), /below a parent/);
  assert.throws(
    () => parseWritesArgs(swap("--data-dir-d", "/h/perf-writes/s/base-1-L-a1")),
    /must differ/
  );
  assert.throws(() => parseWritesArgs(swap("--label", "-x")), /--label/);
  assert.equal(parseWritesArgs(["--help"]).help, true);
});

test("parseProcStat: comm with spaces and parens; ppid field 4, start time field 22", () => {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[0] = "S";
  fields[1] = "7";
  fields[19] = "123456";
  const text = `42 (next-server (v16) x) ${fields.join(" ")}\n`;
  assert.deepEqual(parseProcStat(text), { state: "S", ppid: 7, startTime: "123456" });
  assert.equal(parseProcStat("garbage"), null);
});

test("parseProcIo: write_bytes and wchar, or null", () => {
  const io = "rchar: 1\nwchar: 777\nsyscr: 2\nsyscw: 3\nread_bytes: 4\nwrite_bytes: 4096\n";
  assert.deepEqual(parseProcIo(io), { writeBytes: 4096, wchar: 777 });
  assert.equal(parseProcIo("rchar: 1\n"), null);
});

test("fsTypeFor: longest mount-point prefix, octal escapes", () => {
  const mi = [
    "22 1 0:21 / / rw - overlay overlay rw",
    "30 22 8:1 / /home/user rw - ext4 /dev/sda1 rw",
    "31 22 0:40 / /home/user\\040x rw - tmpfs tmpfs rw",
  ].join("\n");
  assert.equal(fsTypeFor("/home/user/perf-writes/s", mi), "ext4");
  assert.equal(fsTypeFor("/home/user x/a", mi), "tmpfs");
  assert.equal(fsTypeFor("/home/username", mi), "overlay");
  assert.equal(fsTypeFor("/tmp", ""), null);
});

test("artifactTime + windowArtifacts: ':' undone; new AND at/after the start", () => {
  const t0 = Date.parse("2026-11-18T10:00:00.000Z");
  assert.equal(artifactTime("2026-11-18T10-00-00.000Z_abc.json"), t0);
  assert.equal(artifactTime("2026-11-18T10-00-00.000Z_abc.json.tmp"), null);
  assert.equal(artifactTime("notes.json"), null);
  const all = [
    "2026-11-18/2026-11-18T09-59-59.999Z_late-warmup.json", // new but before the start
    "2026-11-18/2026-11-18T10-00-00.000Z_old.json", // in the start set
    "2026-11-18/2026-11-18T10-00-00.000Z_a.json",
    "2026-11-18/2026-11-18T10-00-01.500Z_b.json",
    "2026-11-18/odd.json",
  ];
  const start = new Set(["2026-11-18/2026-11-18T10-00-00.000Z_old.json"]);
  assert.deepEqual(windowArtifacts(all, start, t0), [
    "2026-11-18/2026-11-18T10-00-00.000Z_a.json",
    "2026-11-18/2026-11-18T10-00-01.500Z_b.json",
  ]);
});

test("sizeDeltas: changed, new and removed files only", () => {
  const a = new Map([
    ["db", 100],
    ["same", 5],
    ["gone", 7],
  ]);
  const b = new Map([
    ["db", 160],
    ["same", 5],
    ["new", 0],
  ]);
  assert.deepEqual(sizeDeltas(a, b), { db: 60, new: 0, gone: -7 });
});

const r = (w: number): Reading => ({ writeBytes: w, wchar: w * 2 });
const tr = (key: string, first: number, last: number, gone = false): Tracked => ({
  key,
  pid: Number(key.split(":")[0]),
  startTime: key.split(":")[1] as string,
  first: r(first),
  last: r(last),
  gone,
});

test("windowDelta: deltas, full count for appeared, any exit or failure invalid", () => {
  const start = new Map([["1:10", r(100)]]);
  const ok = windowDelta(
    start,
    new Map([
      ["1:10", tr("1:10", 0, 150)],
      ["2:20", tr("2:20", 30, 40)],
    ]),
    false
  );
  assert.equal(ok.writeBytes, 50 + 40);
  assert.deepEqual(ok.appeared, ["2:20"]);
  assert.equal(ok.valid, true);

  const appearedThenGone = windowDelta(
    start,
    new Map([
      ["1:10", tr("1:10", 0, 150)],
      ["2:20", tr("2:20", 30, 40, true)],
    ]),
    false
  );
  assert.deepEqual(appearedThenGone.exited, ["2:20"]);
  assert.equal(appearedThenGone.valid, false);

  const startGone = windowDelta(start, new Map([["1:10", tr("1:10", 0, 150, true)]]), false);
  assert.equal(startGone.valid, false);
  const startMissing = windowDelta(start, new Map(), false);
  assert.deepEqual(startMissing.exited, ["1:10"]);
  assert.equal(windowDelta(start, new Map([["1:10", tr("1:10", 0, 150)]]), true).valid, false);
});

// ── fake /proc ──────────────────────────────────────────────────────────────

function statLine(pid: number, state: string, start: string, ppid = 1): string {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = state;
  fields[1] = String(ppid);
  fields[19] = start;
  return `${pid} (node) ${fields.join(" ")}\n`;
}

function fakeProc(): {
  root: string;
  put: (
    pid: number,
    o: {
      state?: string;
      start?: string;
      write?: number;
      io?: string | null;
      ppid?: number;
      environ?: string;
    }
  ) => void;
  drop: (pid: number) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-writes-proc-"));
  return {
    root,
    put(pid, o) {
      const d = path.join(root, String(pid));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, "stat"),
        statLine(pid, o.state ?? "S", o.start ?? "100", o.ppid ?? 1)
      );
      const envPath = path.join(d, "environ");
      fs.rmSync(envPath, { recursive: true, force: true });
      // A directory makes the read fail with EISDIR: "unreadable", not "gone".
      if (o.environ === "unreadable") fs.mkdirSync(envPath);
      else fs.writeFileSync(envPath, o.environ ?? "");
      const ioPath = path.join(d, "io");
      if (o.io === null) fs.rmSync(ioPath, { force: true });
      else
        fs.writeFileSync(
          ioPath,
          o.io ?? `wchar: ${(o.write ?? 0) * 2}\nwrite_bytes: ${o.write ?? 0}\n`
        );
    },
    drop(pid) {
      fs.rmSync(path.join(root, String(pid)), { recursive: true, force: true });
    },
  };
}

test("readProc: zombie and missing are gone; unreadable or garbled io is a failure", () => {
  const p = fakeProc();
  try {
    p.put(5, { write: 10 });
    assert.equal(readProc(p.root, 5).kind, "ok");
    p.put(6, { state: "Z" });
    assert.equal(readProc(p.root, 6).kind, "gone");
    assert.equal(readProc(p.root, 999).kind, "gone");
    p.put(7, { io: "nonsense\n" });
    assert.deepEqual(readProc(p.root, 7), { kind: "failed", reason: "io-parse" });
    p.put(8, { io: null });
    assert.equal(readProc(p.root, 8).kind, "gone"); // io gone = exited in between
    fs.mkdirSync(path.join(p.root, "9", "io"), { recursive: true });
    fs.writeFileSync(path.join(p.root, "9", "stat"), statLine(9, "S", "1"));
    assert.deepEqual(readProc(p.root, 9), { kind: "failed", reason: "io-read" }); // EISDIR
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("ProcTracker: windows count deltas; exits, reuse, failures and seen-then-gone invalidate", () => {
  const p = fakeProc();
  let pids: number[] = [];
  const t = new ProcTracker("/d", p.root, () =>
    pids.map((pid): ProcEntry => ({ pid, kind: "match" }))
  );
  try {
    p.put(1, { start: "10", write: 100 });
    pids = [1];
    t.begin();
    p.put(1, { start: "10", write: 160 });
    p.put(2, { start: "20", write: 30 });
    pids = [1, 2];
    t.scan();
    p.put(2, { start: "20", write: 45 });
    let w = t.finish();
    assert.equal(w.writeBytes, 60 + 45);
    assert.deepEqual(w.appeared, ["2:20"]);
    assert.equal(w.valid, true);

    // Next window: pid 2 becomes a zombie (its environ no longer matches).
    t.begin();
    p.put(2, { start: "20", state: "Z" });
    pids = [1];
    w = t.finish();
    assert.deepEqual(w.exited, ["2:20"]);
    assert.equal(w.valid, false);

    // Pid reuse: same pid, new start time = the old process exited.
    t.begin();
    p.put(1, { start: "11", write: 0 });
    w = t.finish();
    assert.ok(w.exited.includes("1:10"));
    assert.equal(w.valid, false);

    // A failed reading of a known process invalidates, even if a later read succeeds.
    p.put(3, { start: "30", write: 5 });
    pids = [3];
    t.begin();
    p.put(3, { start: "30", io: "bad\n" });
    t.scan();
    p.put(3, { start: "30", write: 9 });
    w = t.finish();
    assert.equal(w.readFailed, true);
    assert.equal(w.valid, false);

    // A failed reading at the window's start (baseline) invalidates too.
    p.put(3, { start: "30", io: "bad\n" });
    t.begin();
    p.put(3, { start: "30", write: 20 });
    w = t.finish();
    assert.equal(w.readFailed, true);
    assert.equal(w.valid, false);

    // A matching process that cannot be read when first found invalidates.
    t.begin();
    p.put(4, { start: "40", io: "bad\n" });
    pids = [3, 4];
    w = t.finish();
    assert.equal(w.readFailed, true);

    // A matching process that is gone before it can be read: seen, then exited.
    p.put(4, { start: "40", write: 1 });
    t.begin();
    pids = [3, 4, 5];
    w = t.finish();
    assert.ok(w.exited.includes("5:?"));
    assert.equal(w.valid, false);

    // Gone before the window began: not part of it.
    pids = [3, 4];
    t.begin();
    w = t.finish();
    assert.equal(w.valid, true);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("scanProcForDataDir: own uid only; match, unreadable (with ppid), zombie", () => {
  const p = fakeProc();
  const uid = process.getuid?.() ?? 0;
  try {
    p.put(10, { environ: "A=1\0DATA_DIR=/d\0" });
    p.put(11, { environ: "DATA_DIR=/other\0" });
    p.put(12, { environ: "unreadable", ppid: 10 });
    p.put(13, { state: "Z", start: "55", ppid: 10 });
    p.put(process.pid, { environ: "DATA_DIR=/d\0" }); // this process: never listed
    const byPid = (es: ProcEntry[]) => [...es].sort((a, b) => a.pid - b.pid);
    assert.deepEqual(byPid(scanProcForDataDir("/d", p.root, uid)), [
      { pid: 10, kind: "match" },
      { pid: 12, kind: "unreadable", ppid: 10 },
      { pid: 13, kind: "zombie", ppid: 10, startTime: "55" },
    ]);
    // Another account's processes are not looked at.
    assert.deepEqual(scanProcForDataDir("/d", p.root, uid + 1), []);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("ProcTracker: unreadable or zombie children of tracked processes invalidate; others do not", () => {
  const p = fakeProc();
  let entries: ProcEntry[] = [];
  const t = new ProcTracker("/d", p.root, () => entries);
  try {
    p.put(20, { start: "1", write: 10 });
    entries = [{ pid: 20, kind: "match" }];
    t.begin();
    // An unrelated process of this account with an unreadable environment: ignored.
    entries = [
      { pid: 20, kind: "match" },
      { pid: 99, kind: "unreadable", ppid: 4242 },
    ];
    let w = t.finish();
    assert.equal(w.valid, true);

    // A child of the server that cannot be identified: a failed reading.
    t.begin();
    entries = [
      { pid: 20, kind: "match" },
      { pid: 21, kind: "unreadable", ppid: 20 },
    ];
    w = t.finish();
    assert.equal(w.readFailed, true);
    assert.equal(w.valid, false);

    // A zombie child of the server already present at the window's start: an exit.
    entries = [
      { pid: 20, kind: "match" },
      { pid: 22, kind: "zombie", ppid: 20, startTime: "7" },
    ];
    t.begin();
    w = t.finish();
    assert.ok(w.exited.includes("22:7"));
    assert.equal(w.valid, false);

    // An unrelated zombie: ignored.
    entries = [
      { pid: 20, kind: "match" },
      { pid: 23, kind: "zombie", ppid: 4242, startTime: "8" },
    ];
    t.begin();
    w = t.finish();
    assert.equal(w.valid, true);

    // A tracked process that dies during the start sample stays in the window as an exit.
    p.put(24, { start: "9", write: 3 });
    entries = [
      { pid: 20, kind: "match" },
      { pid: 24, kind: "match" },
    ];
    t.scan();
    p.put(24, { start: "9", state: "Z" });
    entries = [{ pid: 20, kind: "match" }];
    t.begin();
    w = t.finish();
    assert.ok(w.exited.includes("24:9"));
    assert.equal(w.valid, false);

    // The next window does not inherit it.
    t.begin();
    w = t.finish();
    assert.equal(w.valid, true);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("ProcTracker: a parent and its unreadable/zombie child found in the same scan", () => {
  const p = fakeProc();
  try {
    // Baseline sample finds server 30 and its unreadable child 31 together: the window fails.
    p.put(30, { start: "1", write: 10 });
    const a = new ProcTracker("/d", p.root, () => [
      { pid: 30, kind: "match" },
      { pid: 31, kind: "unreadable", ppid: 30 },
    ]);
    a.begin();
    let w = a.finish();
    assert.equal(w.readFailed, true);
    assert.equal(w.valid, false);

    // Same for a zombie child found together with its parent: an exit.
    const b = new ProcTracker("/d", p.root, () => [
      { pid: 32, kind: "zombie", ppid: 30, startTime: "4" }, // listed before its parent
      { pid: 30, kind: "match" },
    ]);
    b.begin();
    w = b.finish();
    assert.ok(w.exited.includes("32:4"));
    assert.equal(w.valid, false);
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true });
  }
});

test("stopAndRemove: deletes only when no process remains, after a bounded wait", async () => {
  const removed: string[] = [];
  let live = [7];
  const kept = await stopAndRemove("/d", {
    stop: async () => undefined,
    pids: () => live,
    remove: (d) => removed.push(d),
    settleMs: 300,
  });
  assert.equal(kept, false);
  assert.deepEqual(removed, []);

  setTimeout(() => (live = []), 100);
  const done = await stopAndRemove("/d", {
    stop: async () => {
      throw new Error("stop failed");
    },
    pids: () => live,
    remove: (d) => removed.push(d),
    settleMs: 2_000,
  });
  assert.equal(done, true);
  assert.deepEqual(removed, ["/d"]);
});

// ── step-11 fix 3 controls ──

test("constants: 6 s settle bounded at 16 s, WAL timer pushed out, default log batching", () => {
  assert.equal(BATCH_SETTLE_MS, 6_000);
  assert.equal(SETTLE_MAX_MS, 16_000);
  assert.equal(WAL_PASSIVE_INTERVAL_OFF_MS, "86400000");
  assert.ok((REMOVED_ENV as readonly string[]).includes("OMNIROUTE_LOG_BATCH_MS"));
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../scripts/perf/write-bytes-probe.ts"),
    "utf8"
  );
  assert.match(source, /env\.OMNIROUTE_WAL_PASSIVE_INTERVAL_MS = WAL_PASSIVE_INTERVAL_OFF_MS;/);
});

test("pacedStart: one per second; a late reply pushes the next start and counts as lateness", () => {
  assert.deepEqual(pacedStart(1_000, 0, null), { at: 1_000, latenessMs: 0 });
  assert.deepEqual(pacedStart(1_000, 3, 3_200), { at: 4_000, latenessMs: 0 });
  assert.deepEqual(pacedStart(1_000, 3, 4_700), { at: 4_700, latenessMs: 700 });
  assert.deepEqual(pacedStart(0, 2, 100, 500), { at: 1_000, latenessMs: 0 });
});

test("settleState: at least 6 s after the last reply and enough artifacts, at most 16 s", () => {
  assert.equal(settleState(5_999, 0, 20, 20), "wait", "artifacts in, but under 6 s");
  assert.equal(settleState(6_000, 0, 20, 20), "done");
  assert.equal(settleState(10_000, 0, 19, 20), "wait", "short of artifacts");
  assert.equal(settleState(15_999, 0, 19, 20), "wait");
  assert.equal(settleState(16_000, 0, 19, 20), "timeout");
  assert.equal(settleState(16_000, 0, 25, 20), "done");
});

test("checkpointWithRetry: retries an incomplete checkpoint up to 3 times, keeps each result", async () => {
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  const done = { busy: 0, log: 5, checkpointed: 5 };
  const busy = { busy: 1, log: 5, checkpointed: 3 };

  const first = await checkpointWithRetry(() => done, wait);
  assert.deepEqual(first, { attempts: [done], ok: true });
  assert.deepEqual(waits, []);

  const seq: CheckpointAttempt[] = [busy, { error: "locked" }, done];
  const later = await checkpointWithRetry(() => seq.shift()!, wait);
  assert.equal(later.ok, true);
  assert.equal(later.attempts.length, 3);
  assert.deepEqual(waits, [200, 200]);

  const never = await checkpointWithRetry(() => busy, wait);
  assert.equal(never.ok, false);
  assert.equal(never.attempts.length, 4, "one try and 3 retries");

  assert.equal(checkpointComplete({ busy: 0, log: -1, checkpointed: -1 }), false, "not WAL");
  assert.equal(checkpointComplete({ busy: 0, log: 0, checkpointed: 0 }), true, "empty WAL");
  assert.equal(checkpointComplete({ busy: 0, log: 4, checkpointed: 3 }), false);
});

function tmpDb(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-writes-db-"));
  return { dir, file: path.join(dir, "storage.sqlite") };
}

test("checkpointOnce + dbReading: a real WAL database; the checkpoint changes the main file", async () => {
  const { dir, file } = tmpDb();
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec("CREATE TABLE t (v BLOB)");
    writer.exec("INSERT INTO t VALUES (zeroblob(65536))");
    const before = dbReading(file);
    assert.ok(before.main && before.walSize !== null && before.walSize > 0);
    assert.ok(before.wal, "WAL header read");
    assert.equal(checkpointInWindow(before, dbReading(file)), false, "nothing changed");

    // A different mtime is guaranteed only across a clock tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = checkpointOnce(file);
    assert.ok(checkpointComplete(result), JSON.stringify(result));
    const after = dbReading(file);
    assert.equal(checkpointInWindow(before, after), true, "the checkpoint wrote the main file");

    const missing: DbReading = { main: null, walSize: null, wal: null };
    assert.equal(checkpointInWindow(missing, after), true);
    // A checkpoint that only rewrites existing pages keeps the size; the mtime still moves.
    const sameSize: DbReading = {
      ...after,
      main: { ...after.main!, mtimeMs: after.main!.mtimeMs + 1 },
    };
    assert.equal(checkpointInWindow(after, sameSize), true, "same size, newer mtime");
    assert.equal(walHeader(path.join(dir, "absent-wal")), null);
    assert.ok("error" in checkpointOnce(path.join(dir, "nope", "x.sqlite")));
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("countWindowRows: in-window usage rows and logical call-log rows only", () => {
  const { dir, file } = tmpDb();
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE usage_history (timestamp TEXT)");
    db.exec("CREATE TABLE call_logs (timestamp TEXT, request_type TEXT)");
    const u = db.prepare("INSERT INTO usage_history VALUES (?)");
    const c = db.prepare("INSERT INTO call_logs VALUES (?, ?)");
    for (const ts of ["2026-11-20T00:00:00.000Z", "2026-11-20T00:00:05.000Z"]) u.run(ts);
    u.run("2026-11-19T23:59:59.999Z");
    c.run("2026-11-20T00:00:01.000Z", null);
    c.run("2026-11-20T00:00:02.000Z", "chat");
    c.run("2026-11-20T00:00:03.000Z", "upstream_http_attempt");
    c.run("2026-11-20T00:00:06.000Z", "chat");
  } finally {
    db.close();
  }
  try {
    assert.deepEqual(
      countWindowRows(file, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:05.000Z"),
      { usage: 2, callLogs: 2 }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function windowFor(overrides: Record<string, unknown> = {}) {
  const reading: DbReading = { main: { size: 4096, mtimeMs: 1 }, walSize: 0, wal: null };
  return {
    valid: true,
    readFailed: false,
    writeBytes: 1000,
    checkpoint: { attempts: [], ok: true },
    db: { start: reading, end: reading },
    startIso: "2026-11-20T00:00:00.000Z",
    endIso: "2026-11-20T00:01:00.000Z",
    rows: null as RowCounts | null,
    ...overrides,
  };
}

test("pacedInvalidReason: each validity case", () => {
  const clean = Array(20).fill(false);
  assert.equal(pacedInvalidReason(windowFor(), clean), null);
  assert.equal(pacedInvalidReason(windowFor({ valid: false }), clean), "paced-exit");
  assert.equal(
    pacedInvalidReason(windowFor({ valid: false, readFailed: true }), clean),
    "paced-read"
  );
  assert.equal(pacedInvalidReason(windowFor({ writeBytes: 0 }), clean), "paced-zero");
  assert.equal(
    pacedInvalidReason(windowFor({ checkpoint: { attempts: [], ok: false } }), clean),
    "paced-checkpoint"
  );
  const moved: DbReading = { main: { size: 8192, mtimeMs: 2 }, walSize: 0, wal: null };
  assert.equal(
    pacedInvalidReason(windowFor({ db: { start: windowFor().db.start, end: moved } }), clean),
    "paced-checkpoint-in-window"
  );
  assert.equal(pacedInvalidReason(windowFor(), clean.slice(1)), "paced-artifacts(19)");
  assert.equal(
    pacedInvalidReason(windowFor(), [...clean.slice(1), null]),
    "paced-artifact-unreadable"
  );
  assert.equal(
    pacedInvalidReason(windowFor(), [...clean.slice(1), true]),
    "paced-artifact-pipeline(D)"
  );
});

function settingWithWindows(): SettingReport {
  return {
    valid: true,
    invalidReason: null,
    m12: 100,
    m13: 5,
    m12c: 50,
    request: windowFor(),
    paced: { ...windowFor(), verdict: { valid: true, reason: null } },
  } as unknown as SettingReport;
}

test("rowCheck: 20 of each per window; request shortfall voids the setting, paced only M12c", () => {
  const failed: string[] = [];
  const fail = (reason: string) => failed.push(reason);
  const full: RowCounts = { usage: 20, callLogs: 21 };

  const ok = settingWithWindows();
  rowCheck(ok, "/db", null, fail, () => full);
  assert.deepEqual(failed, []);
  assert.equal(ok.m12c, 50);
  assert.deepEqual(ok.request!.rows, full);

  // Windows are counted in order: request first, paced second.
  const order: RowCounts[] = [full, { usage: 20, callLogs: 19 }];
  const paced2 = settingWithWindows();
  rowCheck(paced2, "/db", null, fail, () => order.shift()!);
  assert.deepEqual(failed, []);
  assert.equal(paced2.valid, true, "the setting stays valid");
  assert.equal(paced2.m12c, null);
  assert.deepEqual(paced2.paced!.verdict, { valid: false, reason: "paced-rows(20,19)" });

  const reqShort = settingWithWindows();
  rowCheck(reqShort, "/db", null, fail, () => ({ usage: 19, callLogs: 20 }));
  assert.deepEqual(failed, ["rows-request(19,20)"]);

  failed.length = 0;
  const broken = settingWithWindows();
  rowCheck(broken, "/db", null, fail, () => {
    throw new Error("no such table");
  });
  assert.deepEqual(failed, ["rows-request(error)"]);
  assert.equal(broken.request!.rows, null);
  assert.equal(rowsOk(null), false);
});

test("parseVmRssKb: VmRSS line in kB, or null", () => {
  assert.equal(parseVmRssKb("Name:\tnode\nVmRSS:\t  812345 kB\nThreads:\t11\n"), 812345);
  assert.equal(parseVmRssKb("Name:\tkthreadd\n"), null);
});
