/**
 * Addendum A2 (disk writes): one write step, measuring M12 (bytes written during 20 chat
 * requests) and M13 (bytes written in the idle minute after) under two settings:
 *   D: the app's defaults (log file on), background services off, backups disabled;
 *   L: D plus the call-log pipeline and detailed logs on.
 *
 *   node --import tsx/esm scripts/perf/write-bytes-probe.ts --root <arm> --label <label> \
 *     --out <file.json> --log <file.log> --data-dir-d <abs> --data-dir-l <abs> --owner-token <t>
 *
 * Each setting runs on its own claimed data folder and server (spawned like A1's), with a fake
 * upstream, without the probe's counting preload. Bytes are `write_bytes` from /proc/<pid>/io,
 * summed over every process whose environment has DATA_DIR=<folder>, identified by pid plus start
 * time. A window is invalid if any process seen during it exits before its end (a reaped child's
 * counters move to its parent, so its bytes would be double-counted or lost).
 *
 * Step-11 fix 3 controls (OmniRoute may hold log rows up to 5 s): before each request-carrying
 * window the probe checkpoints the database (PASSIVE, node:sqlite, retried up to 3 times) and
 * records the main file's size/mtime and the WAL header; a changed main file means a checkpoint
 * ran inside the window (`checkpoint-in-window`). The server's 5-minute PASSIVE timer is pushed
 * out of the run. Windows settle at least 6 s after their last reply (at most 16 s), then 1 s.
 * Setting D adds a paced window (M12c: 20 requests at one per second) after the idle window.
 * After the server stops, each request-carrying window must hold 20 usage and 20 call-log rows.
 *
 * Exit 0 whenever a report is written; `valid` per setting decides. Exit 1 only when no report
 * could be written. SIGINT/SIGTERM/SIGHUP stop the servers by DATA_DIR, delete the claimed folders
 * and exit 128+signal.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  claimDataDir,
  startFailureReason,
  startServer,
  type Server,
} from "./catalog-cold-probe.ts";
import {
  createCleanupRegistry,
  findPidsByDataDir,
  probeBackgroundOff,
  redactSecrets,
  startFakeUpstream,
  stopProcessesUsing,
} from "./request-io-probe.ts";
import { PROBE_MODEL } from "./request-io-seed.ts";
import { buildChildEnv } from "./lts-baseline.mjs";

export const COUNTER_CHECK_BYTES = 4 * 1024 * 1024;
export const WARMUP_EACH = 3;
export const REQUESTS_EACH = 10;
export const REQUEST_TIMEOUT_MS = 10_000;
export const WARMUP_ARTIFACTS = WARMUP_EACH * 2;
export const WINDOW_ARTIFACTS = REQUESTS_EACH * 2;
export const ARTIFACT_WAIT_MS = 10_000;
export const ARTIFACT_EXTRA_MS = 1_000;
export const IDLE_MS = 60_000;
export const SAMPLE_INTERVAL_MS = 1_000;
export const SEED_TIMEOUT_MS = 60_000;
export const STOP_GRACE_MS = 10_000;
export const KILL_SETTLE_MS = 4_000;
export const LOAD_LIMIT = 2.0;
// Step-11 fix 3: OmniRoute may hold log rows up to 5 s before writing them.
/** A window settles at least this long after its last reply (the batch window plus 1 s). */
export const BATCH_SETTLE_MS = 6_000;
/** ...and at most this long after it. */
export const SETTLE_MAX_MS = 16_000;
export const CHECKPOINT_RETRIES = 3;
export const CHECKPOINT_RETRY_MS = 200;
export const PACED_INTERVAL_MS = 1_000;
/** The server's 5-minute PASSIVE checkpoint timer is pushed out of every window (one day). */
export const WAL_PASSIVE_INTERVAL_OFF_MS = "86400000";
export const DB_FILE_NAME = "storage.sqlite";
/** Removed from the server env so the app's log-file default and the stored pipeline apply. */
export const REMOVED_ENV = [
  "APP_LOG_TO_FILE",
  "APP_LOG_FILE_PATH",
  "ENABLE_REQUEST_LOGS",
  "NODE_OPTIONS",
  "PERF_IO_COUNTER_DIR",
  // Both arms run with OmniRoute's default log batching.
  "OMNIROUTE_LOG_BATCH_MS",
] as const;

export type Setting = "D" | "L";

// ── arguments ────────────────────────────────────────────────────────────────

export interface WritesArgs {
  root: string | null;
  label: string | null;
  out: string | null;
  log: string | null;
  dataDirD: string | null;
  dataDirL: string | null;
  ownerToken: string | null;
  help: boolean;
}

export const WRITES_USAGE = `Usage: node --import tsx/esm scripts/perf/write-bytes-probe.ts --root <arm> --label <label> --out <file.json> --log <file.log> --data-dir-d <abs> --data-dir-l <abs> --owner-token <token>`;

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkDir(flag: string, dir: string): void {
  if (
    !path.isAbsolute(dir) ||
    path.normalize(dir) !== dir ||
    dir.endsWith("/") ||
    path.dirname(dir) === dir
  ) {
    throw new Error(`${flag} must be an absolute, normalized path below a parent folder`);
  }
}

export function parseWritesArgs(argv: string[]): WritesArgs {
  const out: WritesArgs = {
    root: null,
    label: null,
    out: null,
    log: null,
    dataDirD: null,
    dataDirL: null,
    ownerToken: null,
    help: false,
  };
  const flags: Record<string, keyof WritesArgs> = {
    "--root": "root",
    "--label": "label",
    "--out": "out",
    "--log": "log",
    "--data-dir-d": "dataDirD",
    "--data-dir-l": "dataDirL",
    "--owner-token": "ownerToken",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "-h" || flag === "--help") {
      out.help = true;
      continue;
    }
    const key = flags[flag];
    if (!key) throw new Error(`unknown flag: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    (out as unknown as Record<string, string>)[key] = value;
    i++;
  }
  if (out.help) return out;
  for (const [flag, key] of Object.entries(flags)) {
    if (!out[key]) throw new Error(`${flag} is required`);
  }
  if (!LABEL_RE.test(out.label as string)) throw new Error(`--label must match ${LABEL_RE}`);
  checkDir("--data-dir-d", out.dataDirD as string);
  checkDir("--data-dir-l", out.dataDirL as string);
  if (out.dataDirD === out.dataDirL) throw new Error("--data-dir-d and --data-dir-l must differ");
  return out;
}

// ── /proc parsing (pure) ─────────────────────────────────────────────────────

/**
 * State, parent pid (field 4) and start time (field 22, clock ticks) from /proc/<pid>/stat;
 * comm may hold spaces and parens.
 */
export function parseProcStat(
  text: string
): { state: string; ppid: number; startTime: string } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after "pid (comm)": index 0 is field 3 (state), so field 22 is index 19.
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = rest[0];
  const ppid = rest[1];
  const startTime = rest[19];
  if (!state || !ppid || !/^\d+$/.test(ppid) || !startTime || !/^\d+$/.test(startTime)) {
    return null;
  }
  return { state, ppid: Number(ppid), startTime };
}

/** write_bytes and wchar from /proc/<pid>/io. */
export function parseProcIo(text: string): { writeBytes: number; wchar: number } | null {
  const get = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const writeBytes = get("write_bytes");
  const wchar = get("wchar");
  if (writeBytes === null || wchar === null) return null;
  return { writeBytes, wchar };
}

/** Filesystem type of the mount holding `target` (longest mount-point prefix in mountinfo). */
export function fsTypeFor(target: string, mountinfo: string): string | null {
  let best: { mount: string; type: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(" ");
    const right = line.slice(sep + 3).split(" ");
    // Mount points escape spaces etc. as octal (\040).
    const mount = (left[4] ?? "").replace(/\\(\d{3})/g, (_, o) =>
      String.fromCharCode(parseInt(o, 8))
    );
    const type = right[0];
    if (!mount || !type) continue;
    const inside =
      mount === "/" ||
      target === mount ||
      target.startsWith(mount.endsWith("/") ? mount : `${mount}/`);
    if (inside && (!best || mount.length >= best.mount.length)) best = { mount, type };
  }
  return best ? best.type : null;
}

/**
 * Time of a call-log artifact from its file name, `<ISO with ':' as '-'>_<id>.json`
 * (callLogArtifacts.ts buildArtifactRelativePath). Null when the name does not match.
 */
export function artifactTime(name: string): number | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)_.+\.json$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}:${m[2]}:${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

// ── process tracking ─────────────────────────────────────────────────────────

export interface Reading {
  writeBytes: number;
  wchar: number;
}

export interface Tracked {
  key: string; // `${pid}:${startTime}`, or `${pid}:?` for one that exited before it could be read
  pid: number;
  startTime: string;
  first: Reading;
  last: Reading;
  gone: boolean;
}

/** A failed /proc read: the process is gone (ENOENT/ESRCH), or the reading itself failed. */
export type ReadOutcome =
  | { kind: "ok"; startTime: string; state: string; io: Reading }
  | { kind: "gone" }
  | { kind: "failed"; reason: string };

function isGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/**
 * Read one process. Order matters: stat first, so a zombie or a reused pid is "gone" without
 * touching its io file; io next, where ENOENT means it exited in between. Any other error, or a
 * file that does not parse, is a failed reading.
 */
export function readProc(procRoot: string, pid: number): ReadOutcome {
  let statText: string;
  try {
    statText = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (error) {
    return isGoneError(error) ? { kind: "gone" } : { kind: "failed", reason: "stat-read" };
  }
  const stat = parseProcStat(statText);
  if (!stat) return { kind: "failed", reason: "stat-parse" };
  if (stat.state === "Z" || stat.state === "X") return { kind: "gone" };
  let ioText: string;
  try {
    ioText = fs.readFileSync(path.join(procRoot, String(pid), "io"), "utf8");
  } catch (error) {
    return isGoneError(error) ? { kind: "gone" } : { kind: "failed", reason: "io-read" };
  }
  const io = parseProcIo(ioText);
  if (!io) return { kind: "failed", reason: "io-parse" };
  return { kind: "ok", startTime: stat.startTime, state: stat.state, io };
}

export interface WindowResult {
  writeBytes: number;
  wchar: number;
  exited: string[];
  appeared: string[];
  readFailed: boolean;
  failures?: string[];
  valid: boolean;
}

/**
 * Bytes for one window. `seen` holds every process alive at the window's start or first seen
 * during it. One alive at both ends counts its last reading minus its start reading; one that
 * appeared and is alive at the end counts its full last reading; any that is gone at the end
 * (or missing from `seen`) is an exit and makes the window invalid, as does a failed reading.
 */
export function windowDelta(
  atStart: Map<string, Reading>,
  seen: Map<string, Tracked>,
  readFailed: boolean
): WindowResult {
  let writeBytes = 0;
  let wchar = 0;
  const exited: string[] = [];
  const appeared: string[] = [];
  for (const [key, t] of seen) {
    const start = atStart.get(key);
    if (!start) appeared.push(key);
    if (t.gone) {
      exited.push(key);
      continue;
    }
    writeBytes += t.last.writeBytes - (start ? start.writeBytes : 0);
    wchar += t.last.wchar - (start ? start.wchar : 0);
  }
  for (const key of atStart.keys()) if (!seen.has(key)) exited.push(key);
  const valid = !readFailed && exited.length === 0;
  return { writeBytes, wchar, exited, appeared, readFailed, valid };
}

/**
 * One /proc entry of interest to the tracker:
 * - `match`: its environment has DATA_DIR=<folder>;
 * - `unreadable`: its environment could not be read (not because it exited);
 * - `zombie`: it has exited and waits to be reaped (its environment reads empty).
 * `unreadable` and `zombie` entries carry the parent pid; the tracker counts them only when the
 * parent is a tracked process or this probe, so unrelated processes never void a window.
 */
export type ProcEntry =
  | { pid: number; kind: "match" }
  | { pid: number; kind: "unreadable"; ppid: number }
  | { pid: number; kind: "zombie"; ppid: number; startTime: string };

/** Scan /proc for processes of `uid` (this account by default), as ProcEntry. Never throws. */
export function scanProcForDataDir(
  dataDir: string,
  procRoot = "/proc",
  uid: number = process.getuid?.() ?? -1
): ProcEntry[] {
  const wanted = `DATA_DIR=${dataDir}`;
  const out: ProcEntry[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const dir = path.join(procRoot, entry);
    let stat: ReturnType<typeof parseProcStat> = null;
    try {
      if (fs.statSync(dir).uid !== uid) continue;
      stat = parseProcStat(fs.readFileSync(path.join(dir, "stat"), "utf8"));
    } catch {
      continue; // exited between readdir and here, never seen as ours
    }
    if (!stat) continue;
    if (stat.state === "Z" || stat.state === "X") {
      out.push({ pid, kind: "zombie", ppid: stat.ppid, startTime: stat.startTime });
      continue;
    }
    let environ: string;
    try {
      environ = fs.readFileSync(path.join(dir, "environ"), "latin1");
    } catch (error) {
      if (!isGoneError(error)) out.push({ pid, kind: "unreadable", ppid: stat.ppid });
      continue;
    }
    if (environ.split("\0").includes(wanted)) out.push({ pid, kind: "match" });
  }
  return out;
}

/**
 * Live tracker over /proc. Never throws. Known processes are re-read by pid plus start time
 * (not by environ: a zombie's environ is empty, so it would silently stop matching); new ones
 * are found by DATA_DIR in their environ. Failed readings are recorded for the current window.
 */
export class ProcTracker {
  readonly tracked = new Map<string, Tracked>();
  /** Failed readings since the current window began (reset by `begin`). */
  readonly failures: string[] = [];
  private windowKeys = new Set<string>();
  private atStart = new Map<string, Reading>();

  constructor(
    private readonly dataDir: string,
    private readonly procRoot = "/proc",
    private readonly findEntries: (dataDir: string, procRoot: string) => ProcEntry[] = (d, p) =>
      scanProcForDataDir(d, p)
  ) {}

  /** Pids whose children matter: live tracked processes and this probe (the server's parent). */
  private parents(): Set<number> {
    const out = new Set<number>([process.pid]);
    for (const t of this.tracked.values()) if (!t.gone) out.add(t.pid);
    return out;
  }

  /** One sample. */
  scan(): void {
    for (const t of this.tracked.values()) {
      if (t.gone) continue;
      const r = readProc(this.procRoot, t.pid);
      if (r.kind === "failed") {
        this.failures.push(`${t.key}:${r.reason}`);
        continue;
      }
      if (r.kind === "gone" || r.startTime !== t.startTime) {
        t.gone = true;
        continue;
      }
      t.last = r.io;
    }
    // Two passes: matching processes first, so a parent found in this same scan already counts
    // as a parent when its unreadable or zombie children are judged in the second pass.
    const entries = this.findEntries(this.dataDir, this.procRoot);
    for (const e of entries) if (e.kind === "match") this.addMatch(e.pid);
    const parents = this.parents();
    for (const e of entries) {
      const pid = e.pid;
      if (e.kind === "match") continue;
      if (e.kind === "unreadable") {
        // A child of the server we cannot identify: its bytes might be ours.
        if (parents.has(e.ppid)) this.failures.push(`${pid}:environ-unreadable`);
        continue;
      }
      if (e.kind === "zombie") {
        // A child of a tracked process (or of this probe) that has exited: when reaped, its
        // counters move to its parent, so it is an exit of this window.
        const key = `${pid}:${e.startTime}`;
        if (!parents.has(e.ppid)) continue;
        const known = this.tracked.get(key);
        if (known) {
          if (!known.gone) known.gone = true;
        } else {
          const zero = { writeBytes: 0, wchar: 0 };
          this.tracked.set(key, {
            key,
            pid,
            startTime: e.startTime,
            first: zero,
            last: zero,
            gone: true,
          });
        }
        this.windowKeys.add(key);
      }
    }
  }

  /** Start tracking a process found by DATA_DIR (or record why it could not be). */
  private addMatch(pid: number): void {
    const r = readProc(this.procRoot, pid);
    if (r.kind === "failed") {
      this.failures.push(`${pid}:new:${r.reason}`);
      return;
    }
    if (r.kind === "gone") {
      // It matched DATA_DIR a moment ago and has already exited: seen, then gone.
      const key = `${pid}:?`;
      if (!this.tracked.has(key)) {
        const zero = { writeBytes: 0, wchar: 0 };
        this.tracked.set(key, { key, pid, startTime: "?", first: zero, last: zero, gone: true });
        this.windowKeys.add(key);
      }
      return;
    }
    const key = `${pid}:${r.startTime}`;
    if (this.tracked.has(key)) return;
    this.tracked.set(key, {
      key,
      pid,
      startTime: r.startTime,
      first: r.io,
      last: r.io,
      gone: false,
    });
    this.windowKeys.add(key);
  }

  /**
   * Start a window: sample, then remember who is alive and their readings. Failures are cleared
   * before the sample, so a failed baseline reading (a stale or missing start value) counts
   * against this window.
   */
  begin(): void {
    this.failures.length = 0;
    // Keys found during this sample (including one seen and already gone) belong to the window,
    // and so does a tracked process that dies during it: if it is reaped inside the window its
    // counters move to its parent, so it must count as an exit, not be dropped.
    this.windowKeys = new Set();
    const goneBefore = new Set([...this.tracked.values()].filter((t) => t.gone).map((t) => t.key));
    this.scan();
    for (const t of this.tracked.values()) {
      if (t.gone && !goneBefore.has(t.key)) this.windowKeys.add(t.key);
    }
    this.atStart = new Map();
    for (const t of this.tracked.values()) {
      if (t.gone) continue;
      this.windowKeys.add(t.key);
      this.atStart.set(t.key, { ...t.last });
    }
  }

  /** End the window: every process alive at its start or first seen during it. */
  finish(): WindowResult {
    this.scan();
    const seen = new Map<string, Tracked>();
    for (const key of this.windowKeys) {
      const t = this.tracked.get(key);
      if (t) seen.set(key, t);
    }
    const result = windowDelta(this.atStart, seen, this.failures.length > 0);
    return { ...result, failures: [...this.failures] } as WindowResult;
  }
}

// ── files ────────────────────────────────────────────────────────────────────

/** Size of every file under `dir`, by path relative to it. Missing dir: empty map. */
export function fileSizes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (rel: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        try {
          out.set(r, fs.statSync(path.join(dir, r)).size);
        } catch {
          // gone between readdir and stat
        }
      }
    }
  };
  walk("");
  return out;
}

/** Per-file size change between two maps; only changed, new or removed files. */
export function sizeDeltas(
  before: Map<string, number>,
  after: Map<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [f, size] of after) {
    const d = size - (before.get(f) ?? 0);
    if (d !== 0 || !before.has(f)) out[f] = d;
  }
  for (const [f, size] of before) if (!after.has(f)) out[f] = -size;
  return out;
}

/** Finished `.json` artifacts under `<dataDir>/call_logs` (temp files end in .tmp). */
export function listArtifacts(dataDir: string): string[] {
  const root = path.join(dataDir, "call_logs");
  return [...fileSizes(root).keys()].filter((f) => f.endsWith(".json")).sort();
}

/** Artifacts of a window: not in the start set, and timestamped at or after its start. */
export function windowArtifacts(
  all: string[],
  startSet: Set<string>,
  windowStartMs: number
): string[] {
  return all.filter((f) => {
    if (startSet.has(f)) return false;
    const t = artifactTime(path.basename(f));
    return t !== null && t >= windowStartMs;
  });
}

/** Whether an artifact file has a top-level `pipeline` key; null when unreadable. */
export function hasPipeline(file: string): boolean | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.hasOwn(parsed, "pipeline");
  } catch {
    return null;
  }
}

// ── database controls (step-11 fix 3) ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `PRAGMA wal_checkpoint(PASSIVE)` result, or why it could not run. */
export type CheckpointAttempt =
  { busy: number; log: number; checkpointed: number } | { error: string };

export interface CheckpointRun {
  attempts: CheckpointAttempt[];
  /** The last attempt moved every WAL frame into the main file. */
  ok: boolean;
}

export function checkpointComplete(attempt: CheckpointAttempt): boolean {
  return (
    !("error" in attempt) &&
    attempt.busy === 0 &&
    attempt.log >= 0 &&
    attempt.checkpointed === attempt.log
  );
}

/**
 * Checkpoint the server's database from this process, with node:sqlite (built into Node, so the
 * arm's native module is not involved). No read transaction is held: one pragma, then close.
 */
export function checkpointOnce(dbFile: string): CheckpointAttempt {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile);
    const row = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as
      { busy: number; log: number; checkpointed: number } | undefined;
    if (!row) return { error: "no-result" };
    return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
  } catch (error) {
    return { error: errText(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* closed */
    }
  }
}

/**
 * Checkpoint, retrying an incomplete one up to `retries` times `retryMs` apart (arm B can still be
 * writing the ready update of its last warm-up rows). Every result is kept.
 */
export async function checkpointWithRetry(
  run: () => CheckpointAttempt,
  wait: (ms: number) => Promise<void> = sleep,
  retries = CHECKPOINT_RETRIES,
  retryMs = CHECKPOINT_RETRY_MS
): Promise<CheckpointRun> {
  const attempts: CheckpointAttempt[] = [run()];
  while (!checkpointComplete(attempts[attempts.length - 1]) && attempts.length <= retries) {
    await wait(retryMs);
    attempts.push(run());
  }
  return { attempts, ok: checkpointComplete(attempts[attempts.length - 1]) };
}

/** The WAL header's checkpoint sequence and salts; they change when the WAL is reset. */
export function walHeader(
  walFile: string
): { checkpointSeq: number; salt1: number; salt2: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(walFile, "r");
    const buf = Buffer.alloc(32);
    if (fs.readSync(fd, buf, 0, 32, 0) < 32) return null;
    return {
      checkpointSeq: buf.readUInt32BE(12),
      salt1: buf.readUInt32BE(16),
      salt2: buf.readUInt32BE(20),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface DbReading {
  main: { size: number; mtimeMs: number } | null;
  walSize: number | null;
  wal: { checkpointSeq: number; salt1: number; salt2: number } | null;
}

export function dbReading(dbFile: string): DbReading {
  const stat = (file: string): fs.Stats | null => {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  };
  const main = stat(dbFile);
  const wal = stat(`${dbFile}-wal`);
  return {
    main: main ? { size: main.size, mtimeMs: main.mtimeMs } : null,
    walSize: wal ? wal.size : null,
    wal: walHeader(`${dbFile}-wal`),
  };
}

/**
 * In WAL mode only a checkpoint writes the main database file, so a window whose main file
 * changed (size or mtime) had a checkpoint inside it. A missing reading also counts.
 */
export function checkpointInWindow(start: DbReading, end: DbReading): boolean {
  if (!start.main || !end.main) return true;
  return start.main.size !== end.main.size || start.main.mtimeMs !== end.main.mtimeMs;
}

export interface RowCounts {
  usage: number;
  callLogs: number;
}

/**
 * Rows timestamped inside [startIso, endIso]: usage_history, and logical call_logs (not the
 * per-attempt `upstream_http_attempt` rows). Run after the server stops.
 */
export function countWindowRows(dbFile: string, startIso: string, endIso: string): RowCounts {
  const db = new DatabaseSync(dbFile);
  try {
    const n = (sql: string): number =>
      Number((db.prepare(sql).get(startIso, endIso) as { n: number }).n);
    return {
      usage: n("SELECT COUNT(*) AS n FROM usage_history WHERE timestamp >= ? AND timestamp <= ?"),
      callLogs: n(
        "SELECT COUNT(*) AS n FROM call_logs WHERE timestamp >= ? AND timestamp <= ? " +
          "AND (request_type IS NULL OR request_type <> 'upstream_http_attempt')"
      ),
    };
  } finally {
    db.close();
  }
}

export function rowsOk(rows: RowCounts | null, min = WINDOW_ARTIFACTS): boolean {
  return rows !== null && rows.usage >= min && rows.callLogs >= min;
}

// ── timing ───────────────────────────────────────────────────────────────────

/**
 * Paced window: request i starts at t0 + i × interval, or when request i − 1 returned if that is
 * later. Lateness is how far past its planned time it starts.
 */
export function pacedStart(
  t0: number,
  i: number,
  prevEndMs: number | null,
  intervalMs = PACED_INTERVAL_MS
): { at: number; latenessMs: number } {
  const planned = t0 + i * intervalMs;
  const at = Math.max(planned, prevEndMs ?? planned);
  return { at, latenessMs: at - planned };
}

/**
 * Window settle: done once BATCH_SETTLE_MS have passed since the last reply and the window has
 * its artifacts; bounded at SETTLE_MAX_MS after the last reply (then "timeout" if short).
 */
export function settleState(
  nowMs: number,
  lastReplyMs: number,
  artifacts: number,
  want: number
): "wait" | "done" | "timeout" {
  const since = nowMs - lastReplyMs;
  if (since >= BATCH_SETTLE_MS && artifacts >= want) return "done";
  if (since >= SETTLE_MAX_MS) return "timeout";
  return "wait";
}

/** `VmRSS` in kB from /proc/<pid>/status text; null when absent. */
export function parseVmRssKb(text: string): number | null {
  const m = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return m ? Number(m[1]) : null;
}

// ── live run ─────────────────────────────────────────────────────────────────

function errText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Counter self-check: this process writes and fsyncs COUNTER_CHECK_BYTES; write_bytes must grow by that. */
export function counterCheck(dir: string): { wrote: number; seen: number | null; ok: boolean } {
  const self = (): number | null => {
    try {
      return parseProcIo(fs.readFileSync("/proc/self/io", "utf8"))?.writeBytes ?? null;
    } catch {
      return null;
    }
  };
  const file = path.join(dir, ".perf-writes-counter-check");
  const before = self();
  const fd = fs.openSync(file, "wx");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < COUNTER_CHECK_BYTES / chunk.length; i++) fs.writeSync(fd, chunk);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const after = self();
  fs.rmSync(file, { force: true });
  const seen = before === null || after === null ? null : after - before;
  return { wrote: COUNTER_CHECK_BYTES, seen, ok: seen !== null && seen >= COUNTER_CHECK_BYTES };
}

/** One chat request's outcome, kept for every request so a failed window says which and why. */
export type ChatOutcome = {
  stream: boolean;
  /** Start time, ISO, to line up with the server log. */
  at: string;
  ms: number;
  status: number | null;
  /** Set when no reply arrived: error name, message and cause code (no stack). */
  error: string | null;
  /** First 300 characters of a non-200 reply's body. */
  body: string | null;
};

const OUTCOME_TEXT_MAX = 300;

/** `Name: message (cause CODE: message)`, one line, at most 300 characters. */
export function describeRequestError(error: unknown): string {
  const part = (value: unknown): string => {
    if (!value || typeof value !== "object") return String(value);
    const e = value as { name?: unknown; code?: unknown; message?: unknown };
    const head = [e.name, e.code].filter((v) => typeof v === "string" && v).join(" ");
    const message = typeof e.message === "string" ? e.message : "";
    return [head, message].filter(Boolean).join(": ");
  };
  const cause = (error as { cause?: unknown } | null)?.cause;
  const text = cause ? `${part(error)} (cause ${part(cause)})` : part(error);
  return text.replace(/\s+/g, " ").slice(0, OUTCOME_TEXT_MAX);
}

/** One probe chat request; its outcome goes to `outcomes` when given. Exported for its test. */
export async function chat(
  baseUrl: string,
  stream: boolean,
  outcomes?: ChatOutcome[]
): Promise<number | null> {
  const at = new Date().toISOString();
  const started = performance.now();
  const outcome: ChatOutcome = { stream, at, ms: 0, status: null, error: null, body: null };
  try {
    const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PROBE_MODEL,
        stream,
        messages: [{ role: "user", content: "perf write probe" }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    outcome.status = res.status;
    if (res.status === 200) await res.arrayBuffer();
    else outcome.body = (await res.text()).slice(0, OUTCOME_TEXT_MAX);
    return res.status;
  } catch (error) {
    outcome.error = describeRequestError(error);
    return null;
  } finally {
    outcome.ms = Math.round(performance.now() - started);
    outcomes?.push(outcome);
  }
}

async function seed(
  root: string,
  dataDir: string,
  baseUrl: string,
  setting: Setting,
  logFd: number
): Promise<{ ok: boolean; reason: string | null; ms: number; logs: unknown }> {
  const started = performance.now();
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir };
  delete env.ENABLE_REQUEST_LOGS;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      path.join(root, "scripts", "perf", "request-io-seed.ts"),
      "--kind",
      "fake",
      "--base-url",
      baseUrl,
      "--logging",
      setting === "L" ? "on" : "off",
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", logFd], detached: true }
  );
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exitedPromise = new Promise<number | "spawn">((resolve) => {
    child.once("error", () => resolve("spawn"));
    // "close", not "exit": stdout is fully read, so the seed's last line (logs) is not lost.
    child.once("close", (c) => resolve(c ?? 1));
  });
  const timeout = (ms: number): Promise<"timeout"> =>
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms).unref());
  const code = await Promise.race([exitedPromise, timeout(SEED_TIMEOUT_MS)]);
  if (code === "timeout") {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      /* gone */
    }
    await Promise.race([exitedPromise, timeout(5_000)]);
  }
  fs.writeSync(logFd, stdout);
  const ms = performance.now() - started;
  if (code !== 0) {
    const reason =
      code === "timeout" ? "seed-timeout" : code === "spawn" ? "seed-spawn" : `seed-exit-${code}`;
    return { ok: false, reason, ms, logs: null };
  }
  let logs: unknown = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      logs = (JSON.parse(line) as { logs?: unknown }).logs ?? logs;
    } catch {
      // migration logs share stdout
    }
  }
  return { ok: true, reason: null, ms, logs };
}

export interface RequestWindowReport extends WindowResult {
  files: Record<string, number>;
  logDelta: number;
  startIso: string;
  endIso: string;
  checkpoint: CheckpointRun;
  db: { start: DbReading; end: DbReading };
  settled: boolean;
  /** Counted after the server stops; null until then or when the count failed. */
  rows: RowCounts | null;
}

export interface PacedWindowReport extends RequestWindowReport {
  latenessMs: number[];
  artifacts: { window: number; withPipeline: number };
  /** VmRSS of each live server process at the window's end, by process key. */
  rssKb: Record<string, number | null>;
  /** The window's own verdict; `valid` (from WindowResult) is only the process tracker's. */
  verdict: { valid: boolean; reason: string | null };
}

export interface SettingReport {
  setting: Setting;
  dataDir: string;
  counterCheck: { wrote: number; seen: number | null; ok: boolean } | null;
  storedLogs: unknown;
  startedAt: string;
  endedAt: string | null;
  seedMs: number | null;
  bootMs: number | null;
  processes: Array<{ key: string; first: Reading; last: Reading; gone: boolean }>;
  request: RequestWindowReport | null;
  idle: (WindowResult & { files: Record<string, number>; logDelta: number }) | null;
  artifacts: { atStart: number; window: number; withPipeline: number } | null;
  /** Setting D only: 20 requests at one per second, after the idle window. */
  paced: PacedWindowReport | null;
  m12: number | null;
  m13: number | null;
  /** Paced-window bytes; null when that window is invalid (the others can still be valid). */
  m12c: number | null;
  /** Every chat request's outcome per phase, kept on failure too (reported only). */
  outcomes: { warmup: ChatOutcome[]; request: ChatOutcome[]; paced: ChatOutcome[] };
  /** True when the folder was left for the driver's sweep because a process still used it. */
  kept?: boolean;
  valid: boolean;
  invalidReason: string | null;
}

/**
 * Stop every process using `dir`, wait up to KILL_SETTLE_MS for them to be gone, and delete the
 * folder only if none remains. Otherwise keep it, with its owner marker, for the driver's
 * ownership-checked sweep. Returns whether the folder was deleted.
 */
export async function stopAndRemove(
  dir: string,
  deps: {
    stop: (dirs: string[], graceMs: number) => Promise<unknown>;
    pids: (dirs: string[]) => number[];
    remove: (dir: string) => void;
    settleMs?: number;
  } = {
    stop: stopProcessesUsing,
    pids: (dirs) => findPidsByDataDir(dirs),
    remove: (d) => fs.rmSync(d, { recursive: true, force: true }),
  }
): Promise<boolean> {
  await deps.stop([dir], STOP_GRACE_MS).catch(() => undefined);
  const deadline = Date.now() + (deps.settleMs ?? KILL_SETTLE_MS);
  while (deps.pids([dir]).length > 0) {
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
  deps.remove(dir);
  return true;
}

function logSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function waitArtifacts(count: () => number, want: number): Promise<boolean> {
  const deadline = Date.now() + ARTIFACT_WAIT_MS;
  while (Date.now() < deadline) {
    if (count() >= want) break;
    await sleep(200);
  }
  const ok = count() >= want;
  await sleep(ARTIFACT_EXTRA_MS);
  return ok;
}

/**
 * Why a paced window is invalid, or null. Its replies were all 200 (otherwise the setting
 * ended). `flags` holds each window artifact's has-pipeline flag (setting D: all false).
 */
export function pacedInvalidReason(
  window: Pick<RequestWindowReport, "valid" | "readFailed" | "writeBytes" | "checkpoint" | "db">,
  flags: Array<boolean | null>
): string | null {
  if (!window.valid) return window.readFailed ? "paced-read" : "paced-exit";
  if (window.writeBytes <= 0) return "paced-zero";
  if (!window.checkpoint.ok) return "paced-checkpoint";
  if (checkpointInWindow(window.db.start, window.db.end)) return "paced-checkpoint-in-window";
  if (flags.length < WINDOW_ARTIFACTS) return `paced-artifacts(${flags.length})`;
  if (flags.some((v) => v === null)) return "paced-artifact-unreadable";
  if (flags.some((v) => v !== false)) return "paced-artifact-pipeline(D)";
  return null;
}

async function settleWindow(
  lastReplyMs: number,
  count: () => number,
  want: number
): Promise<boolean> {
  let state = settleState(Date.now(), lastReplyMs, count(), want);
  while (state === "wait") {
    await sleep(200);
    state = settleState(Date.now(), lastReplyMs, count(), want);
  }
  await sleep(ARTIFACT_EXTRA_MS);
  return state === "done";
}

/**
 * After the server stops: every request-carrying window must hold at least 20 usage rows and 20
 * logical call-log rows. It shows no row was lost; commit timing inside the window rests on
 * the settle. A failed request-window check invalidates the setting; a failed paced check only
 * the paced window. Exported for its tests.
 */
export function rowCheck(
  report: SettingReport,
  dbFile: string,
  logFd: number | null,
  fail: (reason: string) => void,
  count: (file: string, startIso: string, endIso: string) => RowCounts = countWindowRows
): void {
  for (const window of [report.request, report.paced]) {
    if (!window) continue;
    try {
      window.rows = count(dbFile, window.startIso, window.endIso);
    } catch (error) {
      window.rows = null;
      if (logFd !== null) {
        fs.writeSync(logFd, `[write-bytes-probe] row check failed: ${errText(error)}\n`);
      }
    }
  }
  const label = (rows: RowCounts | null): string =>
    rows ? `${rows.usage},${rows.callLogs}` : "error";
  if (report.valid && report.request && !rowsOk(report.request.rows)) {
    fail(`rows-request(${label(report.request.rows)})`);
  }
  if (report.paced && report.paced.verdict.valid && !rowsOk(report.paced.rows)) {
    report.paced.verdict = { valid: false, reason: `paced-rows(${label(report.paced.rows)})` };
    report.m12c = null;
  }
}

async function runSetting(
  args: WritesArgs,
  setting: Setting,
  report: SettingReport,
  live: { servers: Set<Server>; stoppers: Set<() => Promise<void>> },
  logFd: number
): Promise<void> {
  const root = path.resolve(args.root as string);
  const dir = report.dataDir;
  const logFile = args.log as string;
  const fail = (reason: string): void => {
    report.valid = false;
    report.invalidReason = reason;
    report.m12 = null;
    report.m13 = null;
    report.m12c = null;
  };
  const dbFile = path.join(dir, DB_FILE_NAME);

  report.counterCheck = counterCheck(dir);
  if (!report.counterCheck.ok) return fail("counter-check");

  const upstream = await startFakeUpstream(0);
  live.stoppers.add(upstream.stop);
  let server: Server | null = null;
  const tracker = new ProcTracker(dir);
  let timer: NodeJS.Timeout | null = null;
  try {
    const seeded = await seed(root, dir, upstream.baseUrl, setting, logFd);
    report.seedMs = Math.round(seeded.ms);
    report.storedLogs = seeded.logs;
    if (!seeded.ok) return fail(seeded.reason as string);

    const env: NodeJS.ProcessEnv = { ...buildChildEnv(process.env, dir), ...probeBackgroundOff() };
    for (const key of REMOVED_ENV) delete env[key];
    // A window is ~40 s; the 5-minute PASSIVE timer would land in about 1 window in 8.
    env.OMNIROUTE_WAL_PASSIVE_INTERVAL_MS = WAL_PASSIVE_INTERVAL_OFF_MS;
    try {
      server = await startServer(root, env, logFd);
    } catch (error) {
      fs.writeSync(logFd, `[write-bytes-probe] server start failed: ${errText(error)}\n`);
      return fail(startFailureReason(error));
    }
    live.servers.add(server);
    report.bootMs = Math.round(server.bootMs);
    const baseUrl = server.baseUrl;

    tracker.scan();
    timer = setInterval(() => tracker.scan(), SAMPLE_INTERVAL_MS);

    const outcomes = report.outcomes;
    for (let i = 0; i < WARMUP_EACH; i++) {
      if ((await chat(baseUrl, false, outcomes.warmup)) !== 200) return fail("warmup-status");
    }
    for (let i = 0; i < WARMUP_EACH; i++) {
      if ((await chat(baseUrl, true, outcomes.warmup)) !== 200) return fail("warmup-status");
    }
    if (!(await waitArtifacts(() => listArtifacts(dir).length, WARMUP_ARTIFACTS))) {
      return fail("warmup-artifacts");
    }

    // One request-carrying window: checkpoint, start readings, send, settle, end readings.
    // `send` returns false on a non-200 reply (the caller ends the setting).
    const measureWindow = async (send: () => Promise<boolean>) => {
      const checkpoint = await checkpointWithRetry(() => checkpointOnce(dbFile));
      const startSet = new Set(listArtifacts(dir));
      tracker.begin();
      const dbStart = dbReading(dbFile);
      const filesBefore = fileSizes(dir);
      const logBefore = logSize(logFile);
      const windowStartMs = Date.now();
      if (!(await send())) return null;
      const lastReplyMs = Date.now();
      const inWindow = (): string[] => windowArtifacts(listArtifacts(dir), startSet, windowStartMs);
      const settled = await settleWindow(lastReplyMs, () => inWindow().length, WINDOW_ARTIFACTS);
      const result = tracker.finish();
      const dbEnd = dbReading(dbFile);
      const windowEndMs = Date.now();
      const filesAfter = fileSizes(dir);
      const logAfter = logSize(logFile);
      const arts = inWindow();
      const flags = arts.map((f) => hasPipeline(path.join(dir, "call_logs", f)));
      const window: RequestWindowReport = {
        ...result,
        files: sizeDeltas(filesBefore, filesAfter),
        logDelta: logAfter - logBefore,
        startIso: new Date(windowStartMs).toISOString(),
        endIso: new Date(windowEndMs).toISOString(),
        checkpoint,
        db: { start: dbStart, end: dbEnd },
        settled,
        rows: null,
      };
      return { window, startSet, arts, flags, filesAfter, logAfter };
    };

    // Request window: 10 plain then 10 streamed, back to back.
    const measured = await measureWindow(async () => {
      for (let i = 0; i < REQUESTS_EACH; i++) {
        if ((await chat(baseUrl, false, outcomes.request)) !== 200) return false;
      }
      for (let i = 0; i < REQUESTS_EACH; i++) {
        if ((await chat(baseUrl, true, outcomes.request)) !== 200) return false;
      }
      return true;
    });
    if (!measured) return fail("request-status");
    const req = measured.window;
    report.request = req;
    const { arts, flags } = measured;
    const filesB = measured.filesAfter;
    const logB = measured.logAfter;
    report.artifacts = {
      atStart: measured.startSet.size,
      window: arts.length,
      withPipeline: flags.filter((v) => v === true).length,
    };

    // Idle window.
    tracker.begin();
    await sleep(IDLE_MS);
    const idle = tracker.finish();
    const filesC = fileSizes(dir);
    report.idle = { ...idle, files: sizeDeltas(filesB, filesC), logDelta: logSize(logFile) - logB };

    // Validity (A2 "Validity").
    if (tracker.tracked.size === 0) return fail("no-server-process");
    if (!req.valid) return fail(req.readFailed ? "request-read" : "request-exit");
    if (req.writeBytes <= 0) return fail("request-zero");
    if (!req.checkpoint.ok) return fail("request-checkpoint");
    if (checkpointInWindow(req.db.start, req.db.end)) return fail("checkpoint-in-window");
    if (arts.length < WINDOW_ARTIFACTS) return fail(`artifacts(${arts.length})`);
    const wantPipeline = setting === "L";
    if (flags.some((v) => v === null)) return fail("artifact-unreadable");
    if (flags.some((v) => v !== wantPipeline)) return fail(`artifact-pipeline(${setting})`);
    report.m12 = req.writeBytes;
    report.m13 = idle.valid ? idle.writeBytes : null;
    report.valid = true;
    report.invalidReason = null;

    if (setting !== "D") return;
    // Paced window (M12c): request i at t0 + i s, or when request i - 1 returned if later.
    const latenessMs: number[] = [];
    const paced = await measureWindow(async () => {
      const t0 = Date.now();
      let prevEnd: number | null = null;
      for (let i = 0; i < 2 * REQUESTS_EACH; i++) {
        const { at } = pacedStart(t0, i, prevEnd);
        const wait = at - Date.now();
        if (wait > 0) await sleep(wait);
        latenessMs.push(Math.max(0, Date.now() - (t0 + i * PACED_INTERVAL_MS)));
        const status = await chat(baseUrl, i >= REQUESTS_EACH, outcomes.paced);
        prevEnd = Date.now();
        if (status !== 200) return false;
      }
      return true;
    });
    // A non-200 reply in any window of setting D ends the setting (all its windows invalid).
    if (!paced) return fail("paced-status");
    const rssKb: Record<string, number | null> = {};
    for (const t of tracker.tracked.values()) {
      if (t.gone) continue;
      try {
        rssKb[t.key] = parseVmRssKb(fs.readFileSync(`/proc/${t.pid}/status`, "utf8"));
      } catch {
        rssKb[t.key] = null;
      }
    }
    const pw = paced.window;
    const pacedReason = pacedInvalidReason(pw, paced.flags);
    report.paced = {
      ...pw,
      latenessMs,
      artifacts: {
        window: paced.arts.length,
        withPipeline: paced.flags.filter((v) => v === true).length,
      },
      rssKb,
      verdict: { valid: pacedReason === null, reason: pacedReason },
    };
    report.m12c = pacedReason === null ? pw.writeBytes : null;
  } finally {
    if (timer) clearInterval(timer);
    report.processes = [...tracker.tracked.values()].map((t) => ({
      key: t.key,
      first: t.first,
      last: t.last,
      gone: t.gone,
    }));
    if (server) {
      await server.stop().catch(() => undefined);
      live.servers.delete(server);
    }
    rowCheck(report, dbFile, logFd, fail);
    await upstream.stop().catch(() => undefined);
    live.stoppers.delete(upstream.stop);
    report.endedAt = new Date().toISOString();
  }
}

export interface WritesReport {
  label: string;
  arm: string;
  commit: string;
  load1: number;
  fsType: { data: string | null; out: string | null };
  startedAt: string;
  endedAt: string | null;
  settings: SettingReport[];
  valid: boolean;
  invalidReason: string | null;
}

function writeReport(file: string, report: WritesReport): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function gitSha(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function runWrites(args: WritesArgs): Promise<WritesReport> {
  const root = path.resolve(args.root as string);
  const label = args.label as string;
  const outFile = args.out as string;
  let mountinfo = "";
  try {
    mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    // recorded as null
  }
  const report: WritesReport = {
    label,
    arm: path.basename(root),
    commit: gitSha(root),
    load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    fsType: {
      data: fsTypeFor(path.dirname(args.dataDirD as string), mountinfo),
      out: fsTypeFor(path.dirname(path.resolve(outFile)), mountinfo),
    },
    startedAt: new Date().toISOString(),
    endedAt: null,
    settings: [],
    valid: false,
    invalidReason: null,
  };
  const blank = (setting: Setting, dir: string): SettingReport => ({
    setting,
    dataDir: dir,
    counterCheck: null,
    storedLogs: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    seedMs: null,
    bootMs: null,
    processes: [],
    request: null,
    idle: null,
    artifacts: null,
    paced: null,
    m12: null,
    m13: null,
    m12c: null,
    outcomes: { warmup: [], request: [], paced: [] },
    valid: false,
    invalidReason: null,
  });
  const finish = (reason: string | null): WritesReport => {
    report.endedAt = new Date().toISOString();
    report.valid = reason === null && report.settings.some((s) => s.valid);
    report.invalidReason = reason;
    writeReport(outFile, report);
    return report;
  };

  const plan: Array<[Setting, string]> = [
    ["D", args.dataDirD as string],
    ["L", args.dataDirL as string],
  ];
  if (report.load1 >= LOAD_LIMIT) {
    for (const [s, d] of plan) report.settings.push({ ...blank(s, d), invalidReason: "load" });
    return finish("load");
  }

  const logFd = fs.openSync(args.log as string, "a");
  const claimed: string[] = [];
  const live = { servers: new Set<Server>(), stoppers: new Set<() => Promise<void>>() };
  const cleanup = createCleanupRegistry();
  cleanup.register(async () => {
    for (const s of [...live.servers]) await s.stop().catch(() => undefined);
    for (const stop of [...live.stoppers]) await stop().catch(() => undefined);
    // Servers still booting have no handle yet: find them by DATA_DIR, claimed folders only.
    // A folder a process still uses is kept for the driver's sweep.
    for (const d of claimed) {
      if (!(await stopAndRemove(d).catch(() => false))) {
        try {
          fs.writeSync(logFd, `[write-bytes-probe] kept ${d}: a process still uses it\n`);
        } catch {
          /* log closed */
        }
      }
    }
    claimed.length = 0;
    if (report.endedAt === null) {
      try {
        finish("interrupted");
      } catch {
        /* the driver records the timeout either way */
      }
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
  });
  cleanup.installSignalHandlers();

  try {
    for (const [setting, dir] of plan) {
      const s = blank(setting, dir);
      report.settings.push(s);
      const claimError = claimDataDir(dir, {
        label: `${label}-${setting}`,
        startedAt: s.startedAt,
        token: args.ownerToken as string,
      });
      if (claimError) {
        s.invalidReason = claimError;
        s.endedAt = new Date().toISOString();
        writeReport(outFile, report);
        continue;
      }
      claimed.push(dir);
      try {
        await runSetting(args, setting, s, live, logFd);
      } catch (error) {
        fs.writeSync(logFd, `[write-bytes-probe] ${setting} failed: ${errText(error)}\n`);
        s.valid = false;
        s.invalidReason = s.invalidReason ?? "error";
      }
      if (await stopAndRemove(dir)) {
        claimed.splice(claimed.indexOf(dir), 1);
      } else {
        fs.writeSync(logFd, `[write-bytes-probe] kept ${dir}: a process still uses it\n`);
        s.kept = true;
      }
      writeReport(outFile, report); // partial results survive a timeout
    }
    return finish(null);
  } finally {
    await cleanup.runAll();
  }
}

const invokedAsMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  (async () => {
    const args = parseWritesArgs(process.argv.slice(2));
    if (args.help) {
      console.log(WRITES_USAGE);
      return;
    }
    const report = await runWrites(args);
    console.log(
      JSON.stringify({
        label: report.label,
        valid: report.settings.map((s) => `${s.setting}:${s.valid ? "ok" : s.invalidReason}`),
      })
    );
  })().catch((error: unknown) => {
    console.error(`[write-bytes-probe] ${errText(error)}`);
    process.exit(1);
  });
}
