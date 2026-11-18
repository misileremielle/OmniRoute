import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcTracker,
  artifactTime,
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
  type ProcEntry,
  type Reading,
  type Tracked,
} from "../../scripts/perf/write-bytes-probe.ts";

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
