/**
 * Stage-2 T3 probe: request I/O + latency per 20-request window (M2b, M7, M8, M9).
 *
 * Usage:
 *   node --import tsx/esm scripts/perf/request-io-probe.ts --root <worktree> --out <file.json> [--mode io|real] [--port-base N] [--idle-check-seconds N] [--counters-out <dir>]
 *   node --import tsx/esm scripts/perf/request-io-probe.ts --help
 *
 * --mode io (default): boots the built standalone bundle from <root> (the same
 * boot path as lts-baseline's startTreeServer) under the preload
 * (scripts/perf/request-io-preload.mjs) and fires sequential chat requests at
 * a fake OpenAI-compatible upstream: 20 non-stream (M8) and 20 stream with TTFT
 * (M9a). M7 = server-main + workers counter delta per window. Also reports M2b
 * (warm restart spawn -> first ping 200) and, with --idle-check-seconds N, an
 * extra idle boot whose counter deltas must be 0 (stage-2 "idle preload adds 0").
 *
 * --mode real (M9b): one or two roots (--root-a, optional --root-b), each booted on its own
 * port and DATA_DIR. Reads OPENROUTER_API_KEY from env (never argv), seeds an
 * openrouter apikey connection in each DATA_DIR, sends REAL_REQUESTS_PER_ARM
 * requests per arm (one per REAL_REQUEST_GAP_MS, fixed prompt, max_tokens 16,
 * stream) and records TTFT, status and the served model. A two-arm run
 * alternates arms (AB, BA, ...); a one-arm run sends 10 requests to --root-a.
 * Every DATA_DIR is deleted in a `finally`; with --counters-out <dir> the
 * counter `*.json` files are copied there first. SIGINT/SIGTERM/SIGHUP stop
 * every started server, stop the fake upstream, delete this run's DATA_DIRs
 * (they hold the OpenRouter key), and exit 128+signo.
 *
 * Seeding runs in scripts/perf/request-io-seed.ts as a short child process
 * per DATA_DIR before the server boots (migrations run there; the DB is a
 * per-process singleton), exactly like tests/integration/resilience-http-e2e.test.ts:
 * seed, then closeDbInstance(), then boot.
 *
 * Report shape:
 *   { status, reason?, host, root, sha, metrics: { m2bMs, m7: { nonStream,
 *     stream, idle, driversUsed, otherGroups, flags }, m8: { samplesMs, medianMs },
 *     m9a: { samplesMs, medianMs }, m9b?: [...] } }
 * sha is the git HEAD of `--root` (io) or { a, b } for the real-mode roots
 * (b is null in a single-root run).
 * A failing self-check sets status to "failed" and reports no numbers.
 * Error text never carries a secret: report reasons pass through redactSecrets().
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildChildEnv, startTreeServer } from "./lts-baseline.mjs";

export interface ProbeArgs {
  mode: "io" | "real";
  root: string | null;
  rootA: string | null;
  rootB: string | null;
  out: string | null;
  portBase: number;
  idleCheckSeconds: number;
  countersOut: string | null;
  help: boolean;
}

export interface CounterFile {
  pid: number;
  ppid: number;
  threadId: number;
  isMainThread: boolean;
  argv: string[];
  role: string;
  counts: CounterCounts;
  writtenAt: number;
}

export interface CounterCounts {
  sqlite: {
    statements: number;
    prepare: number;
    exec: number;
    byDriver: Record<string, { statements: number; prepare: number; exec: number }>;
  };
  fsSync: Record<string, number>;
  fsAsync: Record<string, number>;
  fsCallback: Record<string, number>;
  workersCreated: number;
  driversHooked: string[];
  driversUsed: string[];
}

export type CounterGroup = "serverMain" | "workers" | "serveParent" | "otherChildren";

export interface CounterDelta {
  sqliteStatements: number;
  sqlitePrepare: number;
  sqliteExec: number;
  fsSync: number;
  fsAsync: number;
  fsCallback: number;
}

export interface SelfCheckResult {
  ok: boolean;
  failures: string[];
}

export const PROBE_PREFIX = "perfio";
export const PROBE_MODEL = "perfio/test-model";
export const REAL_MODEL = "openrouter/openrouter/free";
export const STREAM_CHUNKS = 20;
export const WARMUP_EACH = 5;
export const WINDOW_REQUESTS = 20;
export const REAL_REQUESTS_PER_ARM = 10;
export const REAL_REQUEST_GAP_MS = 10_000;

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function nonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

/** Parse argv. `--root` is required in io mode; real mode needs `--root-a` (`--root-b` optional). */
export function parseProbeArgs(argv: string[]): ProbeArgs {
  const out: ProbeArgs = {
    mode: "io",
    root: null,
    rootA: null,
    rootB: null,
    out: null,
    portBase: 0,
    idleCheckSeconds: 0,
    countersOut: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--mode": {
        const raw = requireValue(argv, i++, flag);
        if (raw !== "io" && raw !== "real") throw new Error("--mode must be io or real");
        out.mode = raw;
        break;
      }
      case "--root":
        out.root = requireValue(argv, i++, flag);
        break;
      case "--root-a":
        out.rootA = requireValue(argv, i++, flag);
        break;
      case "--root-b":
        out.rootB = requireValue(argv, i++, flag);
        break;
      case "--out":
        out.out = requireValue(argv, i++, flag);
        break;
      case "--counters-out":
        out.countersOut = requireValue(argv, i++, flag);
        break;
      case "--port-base":
        out.portBase = positiveInt(requireValue(argv, i++, flag), flag);
        break;
      case "--idle-check-seconds":
        out.idleCheckSeconds = nonNegativeInt(requireValue(argv, i++, flag), flag);
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return out;
}

export const PROBE_USAGE = `Usage: node --import tsx/esm scripts/perf/request-io-probe.ts --root <worktree> --out <file.json> [--mode io|real] [--port-base N] [--idle-check-seconds N] [--counters-out <dir>]

  --root <dir>            worktree under test (--mode io)
  --root-a/--root-b       the arms under test (--mode real, M9b; --root-b optional)
  --out <file>            report JSON destination
  --mode io|real          io (default): fake upstream, M2b/M7/M8/M9a; real: OpenRouter, M9b
  --port-base <n>         base for ephemeral ports (default: kernel-assigned)
  --idle-check-seconds N  extra idle boot whose counter deltas must be 0
  --counters-out <dir>    copy *.json counter files to <dir> before deleting them
  -h, --help              show this help`;

export function validateProbeArgs(args: ProbeArgs): void {
  if (args.mode === "io" && !args.root) throw new Error("--root is required in --mode io");
  if (args.mode === "real" && !args.rootA) {
    throw new Error("--root-a is required in --mode real (--root-b optional)");
  }
}

/**
 * Secrets must never reach a report: OpenRouter keys come from env, and any
 * error text is scrubbed for bearer material before it is stored.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9\-_]{20,}/g, "[redacted]")
    .replace(/(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)\S+/gi, "$1[redacted]");
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Sum one counter group over a set of counter files. Whole counts, no sampling. */
export function sumCounts(files: CounterFile[]): CounterDelta {
  const total: CounterDelta = {
    sqliteStatements: 0,
    sqlitePrepare: 0,
    sqliteExec: 0,
    fsSync: 0,
    fsAsync: 0,
    fsCallback: 0,
  };
  for (const file of files) {
    total.sqliteStatements += file.counts.sqlite.statements;
    total.sqlitePrepare += file.counts.sqlite.prepare;
    total.sqliteExec += file.counts.sqlite.exec;
    for (const value of Object.values(file.counts.fsSync)) total.fsSync += value;
    for (const value of Object.values(file.counts.fsAsync)) total.fsAsync += value;
    for (const value of Object.values(file.counts.fsCallback)) total.fsCallback += value;
  }
  return total;
}

/** Window delta = after minus before per counter. Counters never decrease: if any
 * `after` count is below its `before` count, throw (naming the counter) instead of
 * clamping — a decrease means a process restarted or a report went missing. */
export function deltaCounts(before: CounterDelta, after: CounterDelta): CounterDelta {
  const delta: CounterDelta = {
    sqliteStatements: 0,
    sqlitePrepare: 0,
    sqliteExec: 0,
    fsSync: 0,
    fsAsync: 0,
    fsCallback: 0,
  };
  for (const key of Object.keys(delta) as Array<keyof CounterDelta>) {
    if (after[key] < before[key]) {
      throw new Error(`counter decreased: ${key} went from ${before[key]} to ${after[key]}`);
    }
    delta[key] = after[key] - before[key];
  }
  return delta;
}

/**
 * Classify a counter file. serverMain = main-thread file whose argv names
 * server-ws.mjs or server.js. serveParent = argv names bin/omniroute.mjs.
 * Workers cannot be identified from one file alone (they share the server
 * main pid); use groupCounterFiles for pid-based worker classification.
 * Everything else is an other child.
 */
export function classifyCounterFile(
  file: Pick<CounterFile, "argv" | "threadId" | "isMainThread" | "pid">,
  serverMainPids?: Set<number> | number[]
): CounterGroup {
  const argv = file.argv.join(" ");
  const isServerBundle = argv.includes("server-ws.mjs") || argv.includes("server.js");
  if (isServerBundle && file.isMainThread && file.threadId === 0) return "serverMain";
  if (serverMainPids) {
    const pids = serverMainPids instanceof Set ? serverMainPids : new Set(serverMainPids);
    if (pids.has(file.pid) && file.threadId > 0) return "workers";
  }
  if (argv.includes("bin/omniroute.mjs")) return "serveParent";
  return "otherChildren";
}

export function groupCounterFiles(files: CounterFile[]): Record<CounterGroup, CounterFile[]> {
  const groups: Record<CounterGroup, CounterFile[]> = {
    serverMain: [],
    workers: [],
    serveParent: [],
    otherChildren: [],
  };
  const serverMainPids = new Set<number>();
  for (const file of files) {
    const argv = file.argv.join(" ");
    const isServerBundle = argv.includes("server-ws.mjs") || argv.includes("server.js");
    if (isServerBundle && file.isMainThread && file.threadId === 0) {
      serverMainPids.add(file.pid);
    }
  }
  for (const file of files) groups[classifyCounterFile(file, serverMainPids)].push(file);
  return groups;
}

/**
 * M7 per window = (server main + workers) delta. Other groups are reported
 * separately, and `childRequestWork` flags an other child that shows request
 * work: counts present in a request window but not in the idle window.
 */
export function otherChildRequestWork(
  requestOther: CounterDelta,
  idleOther: CounterDelta
): boolean {
  const requestTotal =
    requestOther.sqliteStatements +
    requestOther.sqlitePrepare +
    requestOther.sqliteExec +
    requestOther.fsSync +
    requestOther.fsAsync +
    requestOther.fsCallback;
  const idleTotal =
    idleOther.sqliteStatements +
    idleOther.sqlitePrepare +
    idleOther.sqliteExec +
    idleOther.fsSync +
    idleOther.fsAsync +
    idleOther.fsCallback;
  return requestTotal > 0 && idleTotal === 0;
}

/**
 * Self-checks after warmup; any failure means status `failed` and no numbers.
 * Failure conditions (any one fails the run): no server-main counter file; the
 * server-main + workers SQLite statements+prepare+exec total is 0 after warmup
 * (hooks counted nothing); the server main + workers `driversUsed` is empty
 * after warmup (no sqlite driver did real work — `node:sqlite` is hooked at
 * load, so `driversHooked` alone always passes and proves nothing);
 * server-main workersCreated is greater than the number of worker files seen
 * (a created worker never reported). Passes when SQLite counts are > 0, a
 * driver was used, and workersCreated <= worker files.
 */
export function checkSelfChecks(input: {
  serverMain: CounterFile[];
  workers: CounterFile[];
  mainWorkersCreated: number;
}): SelfCheckResult {
  const failures: string[] = [];
  if (input.serverMain.length === 0) {
    failures.push("no server main counter file");
    return { ok: false, failures };
  }
  let sqliteTotal = 0;
  for (const file of [...input.serverMain, ...input.workers]) {
    const sqlite = file.counts.sqlite;
    sqliteTotal += sqlite.statements + sqlite.prepare + sqlite.exec;
  }
  if (sqliteTotal === 0) {
    failures.push("server sqlite total after warmup is 0 (hooks counted nothing)");
  }
  const used = new Set<string>();
  for (const file of [...input.serverMain, ...input.workers]) {
    for (const driver of file.counts.driversUsed) used.add(driver);
  }
  if (used.size === 0) {
    failures.push("no sqlite driver used on the server main + workers after warmup");
  }
  if (input.mainWorkersCreated > input.workers.length) {
    failures.push(
      `server-main workersCreated (${input.mainWorkersCreated}) is greater than ` +
        `the number of worker files seen (${input.workers.length})`
    );
  }
  return { ok: failures.length === 0, failures };
}

/**
 * True when an SSE `data:` payload carries non-empty chat content: JSON whose
 * choices[0].delta has a non-empty `content`, `reasoning` or `reasoning_content` string. False for `[DONE]`,
 * non-JSON payloads, missing/empty content, and role-only deltas
 * (`{"choices":[{"delta":{"role":"assistant"}}]}`).
 */
export function chunkHasContent(data: string): boolean {
  if (data === "[DONE]" || data.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as { delta?: unknown } | null | undefined)?.delta;
  if (typeof delta !== "object" || delta === null) return false;
  // Reasoning models stream their first tokens as reasoning text; those are tokens too.
  const fields = delta as { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
  return [fields.content, fields.reasoning, fields.reasoning_content].some(
    (value) => typeof value === "string" && value.length > 0
  );
}

/**
 * First SSE `data:` chunk with non-empty content. Returns the chunk's arrival
 * offset in ms, or null when no content chunk arrived. TTFT = request start
 * to this chunk.
 */
export function firstContentChunk(samples: Array<{ atMs: number; data: string }>): number | null {
  for (const sample of samples) {
    if (chunkHasContent(sample.data)) return sample.atMs;
  }
  return null;
}

/**
 * Incremental SSE `data:` line reader. `feed(text)` appends a network chunk and
 * returns the complete `data:` payloads seen so far; the trailing partial
 * line is kept for the next feed. Only lines ending in `\n` are parsed.
 * `flush()` emits the trailing partial line when it holds a `data:` payload.
 */
export function createSseLineReader(): {
  feed: (text: string) => string[];
  flush: () => string[];
} {
  let pending = "";
  const parseLine = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    return trimmed.slice("data:".length).trim();
  };
  return {
    feed(text: string): string[] {
      pending += text;
      const chunks: string[] = [];
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const payload = parseLine(line);
        if (payload !== null) chunks.push(payload);
        newline = pending.indexOf("\n");
      }
      return chunks;
    },
    flush(): string[] {
      if (pending.length === 0) return [];
      const payload = parseLine(pending);
      pending = "";
      return payload === null ? [] : [payload];
    },
  };
}

/** Parse raw SSE text into data payloads, in order. `[DONE]` terminates the stream. */
export function parseSseDataChunks(body: string): string[] {
  const chunks: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    chunks.push(trimmed.slice("data:".length).trim());
  }
  return chunks;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("cannot summarize an empty sample set");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export type CleanupFn = () => void | Promise<void>;

export interface CleanupRegistry {
  register: (fn: CleanupFn) => void;
  runAll: () => Promise<void>;
  installSignalHandlers: () => void;
}

/**
 * Signal-safe cleanup registry. `runAll` runs registered cleanups once, in
 * reverse registration order; a throwing cleanup is swallowed so the rest
 * still run. `installSignalHandlers` wires SIGINT/SIGTERM/SIGHUP exactly once
 * per registry: each handler runs the cleanups, then exits with
 * 128 + signal number. The normal-path `finally` blocks stay as-is; the
 * registry only fires early on a signal.
 */
export function createCleanupRegistry(): CleanupRegistry {
  const cleanups: CleanupFn[] = [];
  let ran = false;
  let signalsInstalled = false;
  const runAll = async (): Promise<void> => {
    if (ran) return;
    ran = true;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        await (cleanups[i] as CleanupFn)();
      } catch {
        // One failing cleanup must not stop the others.
      }
    }
  };
  const installSignalHandlers = (): void => {
    if (signalsInstalled) return;
    signalsInstalled = true;
    const signals: Array<{ name: NodeJS.Signals; code: number }> = [
      { name: "SIGINT", code: 128 + 2 },
      { name: "SIGTERM", code: 128 + 15 },
      { name: "SIGHUP", code: 128 + 1 },
    ];
    for (const { name, code } of signals) {
      process.once(name, () => {
        void runAll().finally(() => process.exit(code));
      });
    }
  };
  return {
    register: (fn: CleanupFn): void => {
      cleanups.push(fn);
    },
    runAll,
    installSignalHandlers,
  };
}

/**
 * Pids (not this process) whose environment has `DATA_DIR=<one of dirs>`. Finds a server that
 * `startTreeServer` spawned but has not returned a handle for yet (still booting), and its
 * grandchildren, which inherit the env. Linux `/proc`; unreadable entries are skipped.
 */
export function findPidsByDataDir(dirs: string[], procRoot = "/proc"): number[] {
  const wanted = new Set(dirs.map((dir) => `DATA_DIR=${dir}`));
  const pids: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ = "";
    try {
      environ = fs.readFileSync(path.join(procRoot, entry, "environ"), "latin1");
    } catch {
      continue;
    }
    if (environ.split("\0").some((kv) => wanted.has(kv))) pids.push(pid);
  }
  return pids;
}

/** SIGTERM the process group of every process using one of `dirs`, then SIGKILL survivors. */
export async function stopProcessesUsing(dirs: string[], graceMs = 10_000): Promise<number[]> {
  const signalAll = (pids: number[], signal: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        process.kill(-pid, signal); // detached children lead their own group
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      }
    }
  };
  const first = findPidsByDataDir(dirs);
  if (first.length === 0) return first;
  signalAll(first, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && findPidsByDataDir(dirs).length > 0) await sleep(200);
  signalAll(findPidsByDataDir(dirs), "SIGKILL");
  return first;
}

/**
 * Best-effort copy of every `*.json` counter file into `destDir` (created
 * with mkdir -p). No-op when `destDir` is null (flag not given) or the
 * counter dir is unreadable. `.tmp` partials are never copied. Never throws: it runs
 * before server stop and temp-dir removal in both cleanup paths, which must always run.
 */
export function copyCounterFiles(counterDir: string, destDir: string | null): void {
  if (!destDir) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(counterDir);
  } catch {
    return;
  }
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (error) {
    console.error(`[request-io-probe] --counters-out not written: ${errorMessage(error)}`);
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      fs.copyFileSync(path.join(counterDir, name), path.join(destDir, name));
    } catch {
      // Best effort: one unreadable file must not fail the run.
    }
  }
}

// ── live orchestration (not unit-tested; needs a built dist/) ────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Fake OpenAI-compatible upstream on 127.0.0.1: fixed JSON completion for
 * non-stream requests; a 20-chunk stream for stream requests, the first chunk
 * written at once, then [DONE].
 */
export async function startFakeUpstream(port: number): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const completion = {
    id: "chatcmpl-perfio",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      let stream = false;
      try {
        stream = (JSON.parse(body || "{}") as { stream?: unknown }).stream === true;
      } catch {
        stream = false;
      }
      if (!stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(completion));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const first = JSON.stringify({
        id: "chatcmpl-perfio",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      });
      res.write(`data: ${first}\n\n`);
      for (let i = 1; i < STREAM_CHUNKS; i++) {
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-perfio",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: " ok" }, finish_reason: null }],
          })}\n\n`
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as net.Address)?.port ?? port}/v1`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BOOT_POLL_MS = 1_000;
const BOOT_DEADLINE_MS = 240_000;

async function waitForPing(baseUrl: string): Promise<void> {
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`no /api/health/ping 200: ${redactSecrets(lastError)}`);
}

async function seedDataDir(
  root: string,
  dataDir: string,
  seedArgs: string[]
): Promise<{ queueRaised: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        path.join(root, "scripts", "perf", "request-io-seed.ts"),
        ...seedArgs,
      ],
      { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`seed helper exited with ${code}: ${redactSecrets(stderr)}`.trim()));
        return;
      }
      // The seed prints one JSON line; queueRaised says whether the request
      // queue was raised for the burst (report header, per spec).
      let queueRaised = false;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as { queueRaised?: unknown };
          if (typeof parsed.queueRaised === "boolean") queueRaised = parsed.queueRaised;
        } catch {
          // Migration logs share stdout; only the JSON line matters.
        }
      }
      resolve({ queueRaised });
    });
  });
}

export const COUNTER_READ_ATTEMPTS = 3;
export const COUNTER_READ_RETRY_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readCounterFiles(dir: string): CounterFile[] {
  const files: CounterFile[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // Writes are atomic (temp + rename), so a parse error is real: retry a
    // few times, then throw. `.tmp` files are skipped, never parsed.
    if (name.endsWith(".tmp")) continue;
    const filePath = path.join(dir, name);
    let lastError: unknown = null;
    let parsed = false;
    for (let attempt = 0; attempt < COUNTER_READ_ATTEMPTS; attempt++) {
      try {
        files.push(JSON.parse(fs.readFileSync(filePath, "utf8")) as CounterFile);
        parsed = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < COUNTER_READ_ATTEMPTS) sleepSync(COUNTER_READ_RETRY_MS);
      }
    }
    if (!parsed) {
      throw new Error(`unreadable counter file ${name}: ${errorMessage(lastError)}`);
    }
  }
  return files;
}

interface ServerHandle {
  baseUrl: string;
  bootMs: number;
  stop: () => Promise<void>;
}

/** Background-off env shared with catalog-cold-probe.ts (addendum A1), so both servers match. */
export function probeBackgroundOff(): Record<string, string> {
  return {
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
    OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK: "true",
    OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
}

function probeChildEnv(dataDir: string, counterDir: string, preloadUrl: string): NodeJS.ProcessEnv {
  const env = buildChildEnv(process.env, dataDir);
  return {
    ...env,
    ...probeBackgroundOff(),
    PERF_IO_COUNTER_DIR: counterDir,
    NODE_OPTIONS: `--import ${preloadUrl}`,
  };
}

async function chatOnce(
  baseUrl: string,
  model: string,
  stream: boolean
): Promise<{ status: number; ttftMs: number | null; fullMs: number; chunks: string[] }> {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "perf probe ping" }],
    }),
    // A fake-upstream request should take milliseconds; a hang fails the run.
    signal: AbortSignal.timeout(30_000),
  });
  const ttftSamples: Array<{ atMs: number; data: string }> = [];
  let text = "";
  if (stream && res.body) {
    // Incremental: parse each network read through the line reader so TTFT
    // is the arrival of the first content chunk, not the end of the body.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const lineReader = createSseLineReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const atMs = performance.now() - started;
      const piece = decoder.decode(value, { stream: true });
      text += piece;
      for (const data of lineReader.feed(piece)) {
        ttftSamples.push({ atMs, data });
      }
    }
    text += decoder.decode();
    for (const data of lineReader.flush()) {
      ttftSamples.push({ atMs: performance.now() - started, data });
    }
  } else {
    text = await res.text();
  }
  const fullMs = performance.now() - started;
  return {
    status: res.status,
    ttftMs: stream ? firstContentChunk(ttftSamples) : null,
    fullMs,
    chunks: stream ? parseSseDataChunks(text) : [],
  };
}

async function snapshotSums(
  counterDir: string
): Promise<{ sums: Record<CounterGroup, CounterDelta>; serverFiles: CounterFile[] }> {
  const groups = groupCounterFiles(readCounterFiles(counterDir));
  return {
    sums: {
      serverMain: sumCounts(groups.serverMain),
      workers: sumCounts(groups.workers),
      serveParent: sumCounts(groups.serveParent),
      otherChildren: sumCounts(groups.otherChildren),
    },
    serverFiles: [...groups.serverMain, ...groups.workers],
  };
}

export interface CounterNameDelta {
  name: string;
  delta: number;
}

export interface ServerNameBreakdown {
  fsSync: CounterNameDelta[];
  fsAsync: CounterNameDelta[];
  fsCallback: CounterNameDelta[];
  sqlite: CounterNameDelta[];
}

/**
 * M7 per-name breakdown for the server group (main + workers): per-name
 * deltas for fsSync, fsAsync, fsCallback, and sqlite by driver, each sorted
 * by count descending and capped at the top 20. Names with a 0 delta are
 * omitted. A decreased count throws (same contract as deltaCounts).
 */
export function serverNameDeltas(before: CounterFile[], after: CounterFile[]): ServerNameBreakdown {
  const sumNames = (files: CounterFile[]): ServerNameBreakdown => {
    const fsSync = new Map<string, number>();
    const fsAsync = new Map<string, number>();
    const fsCallback = new Map<string, number>();
    const sqlite = new Map<string, number>();
    for (const file of files) {
      for (const [name, value] of Object.entries(file.counts.fsSync)) {
        fsSync.set(name, (fsSync.get(name) ?? 0) + value);
      }
      for (const [name, value] of Object.entries(file.counts.fsAsync)) {
        fsAsync.set(name, (fsAsync.get(name) ?? 0) + value);
      }
      for (const [name, value] of Object.entries(file.counts.fsCallback)) {
        fsCallback.set(name, (fsCallback.get(name) ?? 0) + value);
      }
      for (const [driver, driverCounts] of Object.entries(file.counts.sqlite.byDriver)) {
        const total = driverCounts.statements + driverCounts.prepare + driverCounts.exec;
        sqlite.set(driver, (sqlite.get(driver) ?? 0) + total);
      }
    }
    const toList = (sums: Map<string, number>): CounterNameDelta[] =>
      [...sums.entries()].map(([name, delta]) => ({ name, delta }));
    return {
      fsSync: toList(fsSync),
      fsAsync: toList(fsAsync),
      fsCallback: toList(fsCallback),
      sqlite: toList(sqlite),
    };
  };
  const beforeSums = sumNames(before);
  const afterSums = sumNames(after);
  const diff = (
    beforeList: CounterNameDelta[],
    afterList: CounterNameDelta[]
  ): CounterNameDelta[] => {
    const beforeByName = new Map(beforeList.map((entry) => [entry.name, entry.delta]));
    const afterByName = new Map(afterList.map((entry) => [entry.name, entry.delta]));
    const names = new Set([...beforeByName.keys(), ...afterByName.keys()]);
    const deltas: CounterNameDelta[] = [];
    for (const name of names) {
      const beforeValue = beforeByName.get(name) ?? 0;
      const afterValue = afterByName.get(name) ?? 0;
      if (afterValue < beforeValue) {
        throw new Error(`counter decreased: ${name} went from ${beforeValue} to ${afterValue}`);
      }
      const delta = afterValue - beforeValue;
      if (delta > 0) deltas.push({ name, delta });
    }
    deltas.sort((a, b) => b.delta - a.delta);
    return deltas.slice(0, 20);
  };
  return {
    fsSync: diff(beforeSums.fsSync, afterSums.fsSync),
    fsAsync: diff(beforeSums.fsAsync, afterSums.fsAsync),
    fsCallback: diff(beforeSums.fsCallback, afterSums.fsCallback),
    sqlite: diff(beforeSums.sqlite, afterSums.sqlite),
  };
}

/** M7 scope: server main + its workers, every counter (keys come from the object itself). */
export function serverTotal(sums: Record<CounterGroup, CounterDelta>): CounterDelta {
  const total: CounterDelta = {
    sqliteStatements: 0,
    sqlitePrepare: 0,
    sqliteExec: 0,
    fsSync: 0,
    fsAsync: 0,
    fsCallback: 0,
  };
  for (const key of Object.keys(total) as Array<keyof CounterDelta>) {
    total[key] = sums.serverMain[key] + sums.workers[key];
  }
  return total;
}

interface IoReport {
  status: "ok" | "failed";
  reason?: string;
  host: ReturnType<typeof os.loadavg> extends never ? never : Record<string, unknown>;
  root: string;
  sha: string | { a: string; b: string | null };
  metrics: Record<string, unknown>;
}

function gitSha(root: string): string {
  try {
    const { execFileSync } = process.getBuiltinModule(
      "node:child_process"
    ) as typeof import("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function hostRecord(): Record<string, unknown> {
  return {
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    nodeVersion: process.version,
  };
}

async function runIoMode(args: ProbeArgs): Promise<IoReport> {
  const root = args.root as string;
  const preloadUrl = pathToFileURL(
    path.join(root, "scripts", "perf", "request-io-preload.mjs")
  ).href;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reqio-"));
  const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reqio-counters-"));
  const ownsDataDir = true;
  const upstreamPort = args.portBase || (await getFreePort());
  const upstream = await startFakeUpstream(upstreamPort);
  let server: ServerHandle | null = null;
  const failures: string[] = [];
  const metrics: Record<string, unknown> = {};
  // Signal path: stop every started server, stop the fake upstream, copy
  // counters out, delete this run's dirs, then exit 128+signal (the registry
  // exits). The normal-path `finally` below stays as-is.
  const signalCleanup = createCleanupRegistry();
  signalCleanup.installSignalHandlers();
  const liveServers = new Set<ServerHandle>();
  const runDirs = new Set<string>([dataDir]); // every DATA_DIR this run creates
  const extraDirs = new Set<string>(); // idle-check counter dirs
  signalCleanup.register(async () => {
    for (const handle of [...liveServers]) {
      await handle.stop().catch(() => undefined);
    }
    // Servers still booting have no handle yet: find them by DATA_DIR, before the dirs go.
    await stopProcessesUsing([...runDirs]).catch(() => undefined);
    await upstream.stop().catch(() => undefined);
    copyCounterFiles(counterDir, args.countersOut);
    for (const dir of [...runDirs, ...extraDirs, counterDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  try {
    const seedResult = await seedDataDir(root, dataDir, [
      "--kind",
      "fake",
      "--base-url",
      upstream.baseUrl,
    ]);
    const serverDataDir = dataDir;
    const env = probeChildEnv(serverDataDir, counterDir, preloadUrl);
    server = (await startTreeServer({ root, env })) as ServerHandle;
    liveServers.add(server);
    await waitForPing(server.baseUrl);

    for (let i = 0; i < WARMUP_EACH; i++) {
      const plain = await chatOnce(server.baseUrl, PROBE_MODEL, false);
      if (plain.status !== 200) {
        return {
          status: "failed",
          reason: `non-200 chat response during warmup: HTTP ${plain.status}`,
          host: hostRecord(),
          root,
          sha: gitSha(root),
          metrics: {},
        };
      }
      const streamed = await chatOnce(server.baseUrl, PROBE_MODEL, true);
      if (streamed.status !== 200) {
        return {
          status: "failed",
          reason: `non-200 streamed chat response during warmup: HTTP ${streamed.status}`,
          host: hostRecord(),
          root,
          sha: gitSha(root),
          metrics: {},
        };
      }
    }

    await sleep(1_000);
    const warmupSnapshot = await snapshotSums(counterDir);
    const afterWarmup = warmupSnapshot.sums;
    const warmupFiles = groupCounterFiles(readCounterFiles(counterDir));
    const mainWorkersCreated = Math.max(
      0,
      ...warmupFiles.serverMain.map((file) => file.counts.workersCreated)
    );
    const usedDrivers = new Set<string>();
    for (const file of warmupFiles.serverMain) {
      for (const driver of file.counts.driversUsed) usedDrivers.add(driver);
    }
    for (const file of warmupFiles.workers) {
      for (const driver of file.counts.driversUsed) usedDrivers.add(driver);
    }
    const selfChecks = checkSelfChecks({
      serverMain: warmupFiles.serverMain,
      workers: warmupFiles.workers,
      mainWorkersCreated,
    });
    if (!selfChecks.ok) {
      return {
        status: "failed",
        reason: `self-checks failed: ${selfChecks.failures.join("; ")}`,
        host: hostRecord(),
        root,
        sha: gitSha(root),
        metrics: {},
      };
    }

    const nonStreamSamples: number[] = [];
    for (let i = 0; i < WINDOW_REQUESTS; i++) {
      const result = await chatOnce(server.baseUrl, PROBE_MODEL, false);
      if (result.status !== 200) {
        return {
          status: "failed",
          reason: `non-200 chat response in non-stream window: HTTP ${result.status}`,
          host: hostRecord(),
          root,
          sha: gitSha(root),
          metrics: {},
        };
      }
      nonStreamSamples.push(result.fullMs);
    }
    await sleep(1_000);
    const nonStreamSnapshot = await snapshotSums(counterDir);
    const afterNonStream = nonStreamSnapshot.sums;

    const streamTtft: number[] = [];
    const streamFull: number[] = [];
    for (let i = 0; i < WINDOW_REQUESTS; i++) {
      const result = await chatOnce(server.baseUrl, PROBE_MODEL, true);
      if (result.status !== 200) {
        return {
          status: "failed",
          reason: `non-200 chat response in stream window: HTTP ${result.status}`,
          host: hostRecord(),
          root,
          sha: gitSha(root),
          metrics: {},
        };
      }
      if (result.ttftMs === null) {
        return {
          status: "failed",
          reason: "stream window: no SSE content chunk received",
          host: hostRecord(),
          root,
          sha: gitSha(root),
          metrics: {},
        };
      }
      streamTtft.push(result.ttftMs);
      streamFull.push(result.fullMs);
    }
    await sleep(1_000);
    const streamSnapshot = await snapshotSums(counterDir);
    const afterStream = streamSnapshot.sums;

    await sleep(10_000);
    const idleSnapshot = await snapshotSums(counterDir);
    const afterIdle = idleSnapshot.sums;

    const m7nonStream = deltaCounts(serverTotal(afterWarmup), serverTotal(afterNonStream));
    const m7stream = deltaCounts(serverTotal(afterNonStream), serverTotal(afterStream));
    const m7idle = deltaCounts(serverTotal(afterStream), serverTotal(afterIdle));
    const otherNonStream = deltaCounts(afterWarmup.otherChildren, afterNonStream.otherChildren);
    const otherStream = deltaCounts(afterNonStream.otherChildren, afterStream.otherChildren);
    const otherIdle = deltaCounts(afterStream.otherChildren, afterIdle.otherChildren);
    const flags: Record<string, boolean> = {
      childRequestWork:
        otherChildRequestWork(otherNonStream, otherIdle) ||
        otherChildRequestWork(otherStream, otherIdle),
      idleNonZero:
        Object.values(m7idle).some((value) => value > 0) ||
        Object.values(otherIdle).some((value) => value > 0),
    };

    const round2 = (n: number): number => Math.round(n * 100) / 100;
    metrics.m8 = {
      samplesMs: nonStreamSamples.map(round2),
      medianMs: round2(median(nonStreamSamples)),
    }; // m7.driversUsed is set with the full m7 report below.
    metrics.m9a = {
      samplesMs: streamTtft.map(round2),
      fullSamplesMs: streamFull.map(round2),
      medianMs: round2(median(streamTtft)),
    };
    metrics.m7 = {
      nonStream: m7nonStream,
      stream: m7stream,
      idle: m7idle,
      driversUsed: [...usedDrivers].sort(),
      otherGroups: {
        nonStream: otherNonStream,
        stream: otherStream,
        idle: otherIdle,
        serveParent: deltaCounts(afterWarmup.serveParent, afterIdle.serveParent),
      },
      flags,
      queueRaised: seedResult.queueRaised,
      breakdown: {
        nonStream: serverNameDeltas(warmupSnapshot.serverFiles, nonStreamSnapshot.serverFiles),
        stream: serverNameDeltas(nonStreamSnapshot.serverFiles, streamSnapshot.serverFiles),
        idle: serverNameDeltas(streamSnapshot.serverFiles, idleSnapshot.serverFiles),
      },
    };

    const stopAt = performance.now();
    await server.stop();
    liveServers.delete(server);
    server = null;
    void stopAt;

    // M2b: warm restart on the same DATA_DIR; bootMs is startTreeServer's own
    // spawn -> first ping 200 timing (same definition as M2a).
    const reboot = (await startTreeServer({
      root,
      env: probeChildEnv(dataDir, counterDir, preloadUrl),
    })) as ServerHandle;
    liveServers.add(reboot);
    try {
      metrics.m2bMs = Math.round(reboot.bootMs * 100) / 100;
    } finally {
      await reboot.stop();
      liveServers.delete(reboot);
    }

    if (args.idleCheckSeconds > 0) {
      const idleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reqio-idle-"));
      const idleCounterDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reqio-idle-c-"));
      runDirs.add(idleDataDir);
      extraDirs.add(idleCounterDir);
      try {
        await seedDataDir(root, idleDataDir, ["--kind", "fake", "--base-url", upstream.baseUrl]);
        const idleServer = (await startTreeServer({
          root,
          env: probeChildEnv(idleDataDir, idleCounterDir, preloadUrl),
        })) as ServerHandle;
        liveServers.add(idleServer);
        try {
          await waitForPing(idleServer.baseUrl);
          await sleep(1_000);
          const idleBefore = readCounterFiles(idleCounterDir);
          await sleep(args.idleCheckSeconds * 1_000);
          const idleAfter = readCounterFiles(idleCounterDir);
          const beforeGroups = groupCounterFiles(idleBefore);
          const afterGroups = groupCounterFiles(idleAfter);
          const deltas: Record<string, CounterDelta> = {
            serverMain: deltaCounts(
              sumCounts(beforeGroups.serverMain),
              sumCounts(afterGroups.serverMain)
            ),
            workers: deltaCounts(sumCounts(beforeGroups.workers), sumCounts(afterGroups.workers)),
            serveParent: deltaCounts(
              sumCounts(beforeGroups.serveParent),
              sumCounts(afterGroups.serveParent)
            ),
            otherChildren: deltaCounts(
              sumCounts(beforeGroups.otherChildren),
              sumCounts(afterGroups.otherChildren)
            ),
          };
          metrics.idleCheck = {
            seconds: args.idleCheckSeconds,
            deltas,
            allZero: Object.values(deltas).every((delta) =>
              Object.values(delta).every((value) => value === 0)
            ),
          };
        } finally {
          await idleServer.stop();
          liveServers.delete(idleServer);
        }
      } finally {
        fs.rmSync(idleDataDir, { recursive: true, force: true });
        fs.rmSync(idleCounterDir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    failures.push(errorMessage(error));
  } finally {
    copyCounterFiles(counterDir, args.countersOut);
    if (server) {
      await server.stop().catch(() => undefined);
      liveServers.delete(server);
    }
    await upstream.stop().catch(() => undefined);
    if (ownsDataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(counterDir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      reason: failures.join("; "),
      host: hostRecord(),
      root,
      sha: gitSha(root),
      metrics: {},
    };
  }
  return { status: "ok", host: hostRecord(), root, sha: gitSha(root), metrics };
}

interface RealSample {
  arm: string;
  status: number;
  ttftMs: number | null;
  fullMs: number;
  model: string | null;
  reason?: string;
}

export const REAL_CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * One real-mode streaming request, read incrementally (same reader as io
 * mode): TTFT = request start to the first content chunk; servedModel comes
 * from the first JSON chunk that carries `model`.
 */
export async function realStreamOnce(
  baseUrl: string,
  body: Record<string, unknown>
): Promise<{ status: number; ttftMs: number | null; fullMs: number; model: string | null }> {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Covers the whole streamed body: a hung upstream becomes a recorded failure.
    signal: AbortSignal.timeout(60_000),
  });
  const status = res.status;
  const ttftSamples: Array<{ atMs: number; data: string }> = [];
  let servedModel: string | null = null;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const lineReader = createSseLineReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const atMs = performance.now() - started;
      const piece = decoder.decode(value, { stream: true });
      for (const data of lineReader.feed(piece)) {
        ttftSamples.push({ atMs, data });
        if (servedModel === null && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data) as { model?: unknown };
            if (typeof parsed.model === "string") servedModel = parsed.model;
          } catch {
            // Non-JSON SSE payload: TTFT still counts, the model stays null.
          }
        }
      }
    }
    for (const data of lineReader.flush()) {
      const atMs = performance.now() - started;
      ttftSamples.push({ atMs, data });
      if (servedModel === null && data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data) as { model?: unknown };
          if (typeof parsed.model === "string") servedModel = parsed.model;
        } catch {
          // Non-JSON SSE payload: TTFT still counts, the model stays null.
        }
      }
    }
  }
  return {
    status,
    ttftMs: firstContentChunk(ttftSamples),
    fullMs: performance.now() - started,
    model: servedModel,
  };
}

async function runRealMode(args: ProbeArgs): Promise<IoReport> {
  const rootA = args.rootA as string;
  const rootB = args.rootB;
  const rootLabel = rootB ? `${rootA} vs ${rootB}` : rootA;
  const sha = { a: gitSha(rootA), b: rootB ? gitSha(rootB) : null };
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) {
    return {
      status: "failed",
      reason: "OPENROUTER_API_KEY is not set",
      host: hostRecord(),
      root: rootLabel,
      sha,
      metrics: {},
    };
  }
  const roots = rootB
    ? [
        { name: "A", root: rootA },
        { name: "B", root: rootB },
      ]
    : [{ name: "A", root: rootA }];
  const dataDirs = roots.map(() => fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reqio-real-")));
  const servers: Array<ServerHandle | null> = roots.map(() => null);
  const samples: RealSample[] = [];
  // Signal path: stop every started server, delete the DATA_DIRs (they hold
  // the OpenRouter key), then exit 128+signal. The normal-path `finally`
  // below stays as-is.
  const signalCleanup = createCleanupRegistry();
  signalCleanup.installSignalHandlers();
  signalCleanup.register(async () => {
    for (const handle of servers) {
      if (handle) await handle.stop().catch(() => undefined);
    }
    // A server still booting has no handle; it must be gone before its key-bearing DATA_DIR is.
    await stopProcessesUsing(dataDirs).catch(() => undefined);
    for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  try {
    for (let i = 0; i < roots.length; i++) {
      await seedDataDir((roots[i] as { root: string }).root, dataDirs[i] as string, [
        "--kind",
        "openrouter",
      ]);
    }
    for (let i = 0; i < roots.length; i++) {
      const entry = roots[i] as { name: string; root: string };
      // Same background-off vars as io mode, but NO preload (no NODE_OPTIONS)
      // and no PERF_IO_COUNTER_DIR.
      const env: NodeJS.ProcessEnv = {
        ...buildChildEnv(process.env, dataDirs[i] as string),
        ...probeBackgroundOff(),
      };
      // The key is already seeded in the DATA_DIR; the server must not also see it in env.
      delete env.OPENROUTER_API_KEY;
      const handle = (await startTreeServer({ root: entry.root, env })) as ServerHandle;
      servers[i] = handle;
      await waitForPing(handle.baseUrl);
    }
    let consecutiveFailures = 0;
    const recordOnce = async (handle: ServerHandle, arm: string): Promise<boolean> => {
      const body = {
        model: REAL_MODEL,
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "perf probe ping" }],
      };
      let status = 0;
      let ttftMs: number | null = null;
      let fullMs = 0;
      let servedModel: string | null = null;
      let reason: string | undefined;
      try {
        const result = await realStreamOnce(handle.baseUrl, body);
        status = result.status;
        ttftMs = result.ttftMs;
        fullMs = result.fullMs;
        servedModel = result.model;
        if (status !== 200) reason = `HTTP ${status}`;
      } catch (error) {
        reason = errorMessage(error) || "fetch failed";
      }
      const failed = reason !== undefined;
      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      samples.push({
        arm,
        status,
        ttftMs: ttftMs === null ? null : Math.round(ttftMs * 100) / 100,
        fullMs: Math.round(fullMs * 100) / 100,
        model: servedModel,
        ...(failed ? { reason: redactSecrets(reason as string) } : {}),
      });
      return consecutiveFailures >= REAL_CONSECUTIVE_FAILURE_LIMIT;
    };
    const limitReport = (): IoReport => ({
      status: "failed",
      reason: `${REAL_CONSECUTIVE_FAILURE_LIMIT} consecutive failed real-mode requests`,
      host: hostRecord(),
      root: rootLabel,
      sha,
      metrics: { m9b: samples },
    });
    if (roots.length === 1) {
      const handle = servers[0] as ServerHandle;
      for (let i = 0; i < REAL_REQUESTS_PER_ARM; i++) {
        if (await recordOnce(handle, "A")) return limitReport();
        await sleep(REAL_REQUEST_GAP_MS);
      }
    } else {
      for (let round = 0; round < REAL_REQUESTS_PER_ARM; round++) {
        // Alternate which arm goes first per round (AB, BA, AB, ...).
        const order = round % 2 === 0 ? [0, 1] : [1, 0];
        for (const arm of order) {
          const handle = servers[arm] as ServerHandle;
          if (await recordOnce(handle, (roots[arm] as { name: string }).name)) {
            return limitReport();
          }
          await sleep(REAL_REQUEST_GAP_MS);
        }
      }
    }
    return {
      status: "ok",
      host: hostRecord(),
      root: rootLabel,
      sha,
      metrics: { m9b: samples },
    };
  } catch (error) {
    return {
      status: "failed",
      reason: errorMessage(error),
      host: hostRecord(),
      root: rootLabel,
      sha,
      metrics: {},
    };
  } finally {
    for (const handle of servers) {
      if (handle) await handle.stop().catch(() => undefined);
    }
    await stopProcessesUsing(dataDirs).catch(() => undefined);
    for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  let args: ProbeArgs;
  try {
    args = parseProbeArgs(process.argv.slice(2));
    if (!args.help) validateProbeArgs(args);
  } catch (error) {
    console.error(`[request-io-probe] ${errorMessage(error)}\n\n${PROBE_USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(PROBE_USAGE);
    return;
  }
  const report = args.mode === "io" ? await runIoMode(args) : await runRealMode(args);
  const json = JSON.stringify(report, null, 2) + "\n";
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, json);
  } else {
    process.stdout.write(json);
  }
  if (report.status !== "ok") process.exit(1);
}

const invokedAsMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  main().catch((error: unknown) => {
    console.error(`[request-io-probe] fatal: ${errorMessage(error)}`);
    process.exit(1);
  });
}
