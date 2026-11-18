/**
 * Addendum A1 (slow answers): one cold-catalog run, measuring M10 (cold `/v1/models` time) and
 * M11 (longest `/api/health/ping` that started during that call).
 *
 *   node --import tsx/esm scripts/perf/catalog-cold-probe.ts --root <arm> --label <label> \
 *     --providers <fixture> --out <file.json> --log <file.log> \
 *     --data-dir $HOME/perf-m10/<session>/<label> --owner-token <token>
 *
 * Runs after a successful probe run, on its own data folder (--data-dir, which must not exist
 * yet; the driver puts each session's folders under their own directory) and its own server; it never touches the probe's folder or server. Steps (A1, "The cold-catalog
 * run"): load check, seed (`request-io-seed.ts --kind catalog`), start one server with
 * CATALOG_BUILD_TIMEOUT_MS=60000, one size call, 5 samples, stop, delete the folder.
 *
 * The server is spawned here with the same command, cwd, env and `detached: true` as
 * lts-baseline's startTreeServer, so its stdout/stderr can go to --log (startTreeServer keeps
 * only an in-memory tail, and every arm keeps its own lts-baseline.mjs).
 *
 * Exit 0 whenever a report is written, valid or not: `valid` and `invalidReason` in the JSON
 * decide. Exit 1 only when no report could be written. SIGINT/SIGTERM/SIGHUP stop the server
 * by its DATA_DIR, delete the folders and exit 128+signal (createCleanupRegistry).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createCleanupRegistry,
  findPidsByDataDir,
  median,
  probeBackgroundOff,
  redactSecrets,
  stopProcessesUsing,
} from "./request-io-probe.ts";
import { CATALOG_TTL_MS } from "./request-io-seed.ts";
import { buildChildEnv } from "./lts-baseline.mjs";

export const SAMPLES = 5;
export const MIN_VALID_SAMPLES = 4;
export const WAIT_MS = 32_000; // 1 s TTL + 30 s stale window + 1 s margin
export const PRE_CALL_MS = 300;
export const POST_CALL_MS = 1_000;
export const PING_INTERVAL_MS = 100;
export const CALL_TIMEOUT_MS = 70_000; // server build timeout 60 s + margin
export const PING_TIMEOUT_MS = 10_000;
export const SEED_TIMEOUT_MS = 60_000;
export const BOOT_DEADLINE_MS = 240_000;
export const BOOT_POLL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;
export const SERVER_BUILD_TIMEOUT_MS = 60_000;
export const LOAD_LIMIT = 2.0;
export const TIMEOUT_HEADERS = new Set(["last-good", "build-timeout"]);

export interface ColdArgs {
  root: string | null;
  label: string | null;
  providers: string | null;
  out: string | null;
  log: string | null;
  dataDir: string | null;
  ownerToken: string | null;
  help: boolean;
}

export const COLD_USAGE = `Usage: node --import tsx/esm scripts/perf/catalog-cold-probe.ts --root <arm> --label <label> --providers <file> --out <file.json> --log <file.log> --data-dir <absolute, not existing> --owner-token <token>`;

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseColdArgs(argv: string[]): ColdArgs {
  const out: ColdArgs = {
    root: null,
    label: null,
    providers: null,
    out: null,
    log: null,
    dataDir: null,
    ownerToken: null,
    help: false,
  };
  const flags: Record<string, keyof ColdArgs> = {
    "--root": "root",
    "--label": "label",
    "--providers": "providers",
    "--out": "out",
    "--log": "log",
    "--data-dir": "dataDir",
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
  // The data folder is deleted afterwards: absolute, normalized, never a filesystem root.
  const dir = out.dataDir as string;
  if (
    !path.isAbsolute(dir) ||
    path.normalize(dir) !== dir ||
    dir.endsWith("/") ||
    path.dirname(dir) === dir
  ) {
    throw new Error("--data-dir must be an absolute, normalized path below a parent folder");
  }
  return out;
}

export interface CallResult {
  status: number | null; // null: no response (timeout or network error)
  ms: number;
  ttfbMs: number | null;
  bytes: number;
  catalogHeader: string | null;
  error: string | null;
  body?: Buffer;
}

export interface Ping {
  startMs: number;
  durMs: number;
  timedOut: boolean;
}

export interface Sample {
  i: number;
  status: number | null;
  ms: number;
  ttfbMs: number | null;
  bytes: number;
  catalogHeader: string | null;
  maxPingMs: number | null;
  pings: number;
  pingTimedOut: boolean;
  invalidReason: string | null;
}

/** Why a sample does not count, or null. Order: no response, status, timeout-path header. */
export function sampleInvalidReason(call: CallResult): string | null {
  if (call.status === null) return call.error ? `no-response(${call.error})` : "no-response";
  if (call.status !== 200) return `status-${call.status}`;
  if (call.catalogHeader && TIMEOUT_HEADERS.has(call.catalogHeader)) {
    return `header-${call.catalogHeader}`;
  }
  return null;
}

/** Pings that started inside [fromMs, toMs]: their count, longest time, any timeout. */
export function pingsDuring(
  pings: Ping[],
  fromMs: number,
  toMs: number
): { count: number; maxMs: number | null; timedOut: boolean } {
  const inside = pings.filter((p) => p.startMs >= fromMs && p.startMs <= toMs);
  if (inside.length === 0) return { count: 0, maxMs: null, timedOut: false };
  return {
    count: inside.length,
    maxMs: Math.max(...inside.map((p) => p.durMs)),
    timedOut: inside.some((p) => p.timedOut),
  };
}

export function buildSample(i: number, call: CallResult, callStart: number, pings: Ping[]): Sample {
  const during = pingsDuring(pings, callStart, callStart + call.ms);
  return {
    i,
    status: call.status,
    ms: call.ms,
    ttfbMs: call.ttfbMs,
    bytes: call.bytes,
    catalogHeader: call.catalogHeader,
    maxPingMs: during.maxMs,
    pings: during.count,
    pingTimedOut: during.timedOut,
    invalidReason: sampleInvalidReason(call),
  };
}

/**
 * M10 = median of valid sample times; M11 = largest valid sample's in-call ping maximum.
 * A run with fewer than MIN_VALID_SAMPLES valid samples is invalid, and both are null.
 */
export function summarizeSamples(samples: Sample[]): {
  m10: number | null;
  m11: number | null;
  validSamples: number;
  invalidReason: string | null;
} {
  const valid = samples.filter((s) => s.invalidReason === null);
  if (valid.length < MIN_VALID_SAMPLES) {
    return {
      m10: null,
      m11: null,
      validSamples: valid.length,
      invalidReason: `samples(${valid.length}/${samples.length} valid)`,
    };
  }
  const pingMax = valid.map((s) => s.maxPingMs).filter((v): v is number => v !== null);
  return {
    m10: median(valid.map((s) => s.ms)),
    m11: pingMax.length ? Math.max(...pingMax) : null,
    validSamples: valid.length,
    invalidReason: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** GET with a client timeout; times to headers (ttfb) and to the last body byte. */
export async function timedGet(
  url: string,
  timeoutMs: number,
  keepBody = false
): Promise<CallResult> {
  const started = performance.now();
  let ttfbMs: number | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    ttfbMs = performance.now() - started;
    const body = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ms: performance.now() - started,
      ttfbMs,
      bytes: body.length,
      catalogHeader: res.headers.get("x-omniroute-catalog"),
      error: null,
      ...(keepBody ? { body } : {}),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      status: null,
      ms: performance.now() - started,
      ttfbMs,
      bytes: 0,
      catalogHeader: null,
      error: name === "TimeoutError" ? "timeout" : errText(error),
    };
  }
}

/**
 * Ping loop: one ping in flight at a time; each starts PING_INTERVAL_MS after the previous one
 * started, or when it ends if later. `stop()` ends the loop after the ping in flight finishes
 * (at most PING_TIMEOUT_MS), so a stall that outlasts the call is still recorded.
 */
export function startPingLoop(
  ping: () => Promise<{ timedOut: boolean }>,
  now: () => number = () => performance.now(),
  wait: (ms: number) => Promise<void> = sleep,
  intervalMs = PING_INTERVAL_MS
): { pings: Ping[]; stop: () => Promise<void> } {
  const pings: Ping[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const startMs = now();
      const { timedOut } = await ping();
      pings.push({ startMs, durMs: now() - startMs, timedOut });
      const left = startMs + intervalMs - now();
      if (!stopped && left > 0) await wait(left);
    }
  })();
  return {
    pings,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

/**
 * One ping, read to the last body byte under one PING_TIMEOUT_MS deadline. A deadline hit on the
 * headers or the body flags `timedOut` ("at least 10 s"); other errors only cost their time.
 */
export async function pingOnce(
  baseUrl: string,
  timeoutMs = PING_TIMEOUT_MS
): Promise<{ timedOut: boolean }> {
  try {
    const res = await fetch(`${baseUrl}/api/health/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Not caught separately: a body that stalls past the deadline must flag as a timeout.
    await res.arrayBuffer();
    return { timedOut: false };
  } catch (error) {
    // A ping that fails fast (not a timeout) still has its time recorded; only timeouts flag.
    return { timedOut: error instanceof Error && error.name === "TimeoutError" };
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      srv.close(() => resolve(address.port));
    });
  });
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Seed the folder through the arm's own seed helper, under SEED_TIMEOUT_MS. */
async function runSeed(
  root: string,
  dataDir: string,
  providers: string,
  logFd: number
): Promise<{ ok: boolean; reason: string | null; ms: number }> {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      path.join(root, "scripts", "perf", "request-io-seed.ts"),
      "--kind",
      "catalog",
      "--providers",
      providers,
    ],
    {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );
  let spawnError: Error | null = null;
  child.once("error", (e) => (spawnError = e));
  const exited = await waitExit(child, SEED_TIMEOUT_MS);
  if (!exited) {
    killGroup(child, "SIGKILL");
    await waitExit(child, 5_000);
    return { ok: false, reason: "seed-timeout", ms: performance.now() - started };
  }
  if (spawnError) return { ok: false, reason: "seed-spawn", ms: performance.now() - started };
  const ok = child.exitCode === 0;
  return { ok, reason: ok ? null : `seed-exit-${child.exitCode}`, ms: performance.now() - started };
}

/**
 * A start failure with a fixed reason code. The code goes into the report and runs.tsv as is:
 * error text passes through redactSecrets, which would blank any 20+ character run such as
 * "server-boot-deadline".
 */
export class StartError extends Error {
  readonly code: string;
  constructor(code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** The reason recorded for a failed server start: the fixed code, never redacted text. */
export function startFailureReason(error: unknown): string {
  return error instanceof StartError ? error.code : "server-start";
}

export interface Server {
  baseUrl: string;
  bootMs: number;
  stop: () => Promise<void>;
}

/** Same spawn as lts-baseline's startTreeServer, with output to the log. Also used by A2. */
export async function startServer(
  root: string,
  env: NodeJS.ProcessEnv,
  logFd: number
): Promise<Server> {
  fs.mkdirSync(env.DATA_DIR as string, { recursive: true });
  const port = await getFreePort();
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [path.join(root, "bin", "omniroute.mjs"), "serve", "--port", String(port), "--no-open"],
    {
      cwd: root,
      env: { ...env, NODE_ENV: "production", PORT: String(port) },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );
  let spawnError: Error | null = null;
  child.once("error", (e) => (spawnError = e));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child, "SIGTERM");
    if (await waitExit(child, STOP_GRACE_MS)) return;
    killGroup(child, "SIGKILL");
    await waitExit(child, 5_000);
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new StartError("server-spawn", errText(spawnError));
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new StartError(`server-exit-${child.exitCode ?? child.signalCode}`);
      }
      try {
        const res = await fetch(`${baseUrl}/api/health/ping`, {
          signal: AbortSignal.timeout(5_000),
        });
        await res.arrayBuffer().catch(() => undefined);
        if (res.status === 200) return { baseUrl, bootMs: performance.now() - started, stop };
      } catch {
        // not listening yet
      }
      await sleep(BOOT_POLL_MS);
    }
    throw new StartError("server-boot-deadline");
  } catch (error) {
    await stop();
    throw error;
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitSha(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export interface ColdReport {
  label: string;
  arm: string;
  commit: string;
  providersPath: string;
  providersSha256: string;
  ttlMs: number;
  catalogBuildTimeoutMs: number;
  load1: number;
  startedAt: string;
  endedAt: string | null;
  seedMs: number | null;
  bootMs: number | null;
  catalogSize: number | null;
  sizeCall: { status: number | null; ms: number; catalogHeader: string | null } | null;
  samples: Sample[];
  m10: number | null;
  m11: number | null;
  valid: boolean;
  invalidReason: string | null;
}

export const OWNER_MARKER = ".perf-m10-owner";

/**
 * Claim `dataDir` for this run: refuse if any process already uses it as DATA_DIR, then create
 * it with a non-recursive mkdir, which fails with EEXIST if it exists. Only a folder created
 * here is ever stopped or deleted by this run. Writes OWNER_MARKER (label, pid, start time),
 * so the driver's after-failure sweep can check ownership before deleting anything.
 */
export function claimDataDir(
  dataDir: string,
  owner: { label: string; startedAt: string; token: string },
  pidsUsing: (dirs: string[]) => number[] = findPidsByDataDir
): string | null {
  if (pidsUsing([dataDir]).length > 0) return "data-dir-in-use";
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  try {
    fs.mkdirSync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "data-dir-exists";
    throw error;
  }
  fs.writeFileSync(
    path.join(dataDir, OWNER_MARKER),
    `${JSON.stringify({ ...owner, pid: process.pid })}\n`
  );
  return null;
}

function writeReport(file: string, report: ColdReport): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export async function runCold(args: ColdArgs): Promise<ColdReport> {
  const root = path.resolve(args.root as string);
  const label = args.label as string;
  const outFile = args.out as string;
  const providers = path.resolve(args.providers as string);
  const report: ColdReport = {
    label,
    arm: path.basename(root),
    commit: gitSha(root),
    providersPath: providers,
    providersSha256: sha256File(providers),
    ttlMs: CATALOG_TTL_MS,
    catalogBuildTimeoutMs: SERVER_BUILD_TIMEOUT_MS,
    load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    startedAt: new Date().toISOString(),
    endedAt: null,
    seedMs: null,
    bootMs: null,
    catalogSize: null,
    sizeCall: null,
    samples: [],
    m10: null,
    m11: null,
    valid: false,
    invalidReason: null,
  };
  const finish = (reason: string | null): ColdReport => {
    report.endedAt = new Date().toISOString();
    if (reason !== null) {
      report.valid = false;
      report.invalidReason = reason;
      report.m10 = null;
      report.m11 = null;
    }
    writeReport(outFile, report);
    return report;
  };
  if (report.load1 >= LOAD_LIMIT) return finish("load");

  const dataDir = args.dataDir as string;
  // Nothing is stopped or deleted before the folder is ours.
  const claimError = claimDataDir(dataDir, {
    label,
    startedAt: report.startedAt,
    token: args.ownerToken as string,
  });
  if (claimError) return finish(claimError);
  const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-m10-counters-"));
  const logFd = fs.openSync(args.log as string, "a");
  let server: Server | null = null;

  const cleanup = createCleanupRegistry();
  cleanup.register(async () => {
    if (server) await server.stop().catch(() => undefined);
    // A server still booting has no handle yet: find it by DATA_DIR before the folder goes.
    await stopProcessesUsing([dataDir], STOP_GRACE_MS).catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(counterDir, { recursive: true, force: true });
    if (report.endedAt === null) {
      try {
        finish(report.invalidReason ?? "interrupted");
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
    const seed = await runSeed(root, dataDir, providers, logFd);
    report.seedMs = Math.round(seed.ms);
    if (!seed.ok) return finish(seed.reason);

    const preloadUrl = pathToFileURL(
      path.join(root, "scripts", "perf", "request-io-preload.mjs")
    ).href;
    const env: NodeJS.ProcessEnv = {
      ...buildChildEnv(process.env, dataDir),
      ...probeBackgroundOff(),
      PERF_IO_COUNTER_DIR: counterDir,
      NODE_OPTIONS: `--import ${preloadUrl}`,
      CATALOG_BUILD_TIMEOUT_MS: String(SERVER_BUILD_TIMEOUT_MS),
    };
    try {
      server = await startServer(root, env, logFd);
    } catch (error) {
      fs.writeSync(logFd, `[catalog-cold-probe] server start failed: ${errText(error)}\n`);
      return finish(startFailureReason(error));
    }
    report.bootMs = Math.round(server.bootMs);
    const modelsUrl = `${server.baseUrl}/v1/models`;

    const size = await timedGet(modelsUrl, CALL_TIMEOUT_MS, true);
    report.sizeCall = { status: size.status, ms: size.ms, catalogHeader: size.catalogHeader };
    const sizeInvalid = sampleInvalidReason(size);
    if (sizeInvalid) return finish(`size-call(${sizeInvalid})`);
    try {
      const data = (JSON.parse((size.body as Buffer).toString("utf8")) as { data?: unknown }).data;
      if (!Array.isArray(data)) return finish("size-call(no data array)");
      report.catalogSize = data.length;
    } catch {
      return finish("size-call(bad json)");
    }

    const baseUrl = server.baseUrl;
    for (let i = 1; i <= SAMPLES; i++) {
      await sleep(WAIT_MS);
      const loop = startPingLoop(() => pingOnce(baseUrl));
      await sleep(PRE_CALL_MS);
      const callStart = performance.now();
      const call = await timedGet(modelsUrl, CALL_TIMEOUT_MS);
      await sleep(POST_CALL_MS);
      await loop.stop();
      report.samples.push(buildSample(i, call, callStart, loop.pings));
      writeReport(outFile, report); // partial results survive a timeout
    }

    const summary = summarizeSamples(report.samples);
    report.m10 = summary.m10;
    report.m11 = summary.m11;
    report.valid = summary.invalidReason === null;
    report.invalidReason = summary.invalidReason;
    return finish(summary.invalidReason);
  } finally {
    await cleanup.runAll();
  }
}

const invokedAsMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  (async () => {
    const args = parseColdArgs(process.argv.slice(2));
    if (args.help) {
      console.log(COLD_USAGE);
      return;
    }
    const report = await runCold(args);
    console.log(
      JSON.stringify({ label: report.label, valid: report.valid, reason: report.invalidReason })
    );
  })().catch((error: unknown) => {
    console.error(`[catalog-cold-probe] ${errText(error)}`);
    process.exit(1);
  });
}
