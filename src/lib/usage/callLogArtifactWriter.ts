import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { resolveWritableDataDir } from "../dataPaths";
import { getCallLogPipelineMaxSizeBytes, isChatDebugFileEnabled } from "../logEnv";
import { getProcessStore } from "@/shared/utils/processSingleton";

import {
  MAX_CALL_LOG_ARTIFACT_BYTES,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";

const MAX_QUEUED_JOBS = 128;
const IDLE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
const WARNING_INTERVAL_MS = 30_000;
/** What a detail file being serialized counts as when CHAT_DEBUG_FILE lifts the size limit. */
const UNBOUNDED_PENDING_BYTES = 16 * 1024 * 1024;

type WriteEnvironment = {
  pipelineMaxSizeKb?: string;
  chatDebugFile?: string;
  appLogLevel?: string;
  dataDir?: string;
};

type WorkerReply = { id: number } & Record<string, unknown>;

type QueueItem = {
  id: number;
  /** Posted to the worker with `id` added. */
  message: Record<string, unknown>;
  /** Serialize jobs only: the held key, tagged with the worker instance once posted. */
  heldKey?: number;
  /** Counts against MAX_QUEUED_JOBS; write and release jobs of held files do not. */
  capped: boolean;
  /** Receives the worker's reply, or null when the job failed or was dropped. */
  resolve: (reply: WorkerReply | null) => void;
};

/** One finished (or still serializing) detail file the worker holds for a queued row. */
type HeldRecord = {
  /** Worker instance holding the string; null until its serialize job is posted. */
  instance: number | null;
  /** Byte length once serialized; the size-limit estimate before that. */
  bytes: number;
};

/**
 * All writer state lives in one process-wide store (#18678: Next.js loads the instrumentation
 * code and the routes as separate module copies). A row's detail is serialized by the copy that
 * saves it and written by the copy that flushes the log batch; both must reach one worker.
 */
type WriterState = {
  worker: Worker | null;
  workerInstance: number;
  active: QueueItem | null;
  queue: QueueItem[];
  nextId: number;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
  closeWaiters: Array<() => void>;
  held: Map<number, HeldRecord>;
  heldBytes: number;
  nextKey: number;
};

const state = getProcessStore<WriterState>("callLogArtifactWriter", () => ({
  worker: null,
  workerInstance: 0,
  active: null,
  queue: [],
  nextId: 1,
  idleTimer: null,
  closing: false,
  closeWaiters: [],
  held: new Map(),
  heldBytes: 0,
  nextKey: 1,
}));

// Per module copy on purpose: a warning throttle and a test hook.
let lastWarningAt = 0;

function fileExistsAtRuntime(candidate: string): boolean {
  // The worker is copied explicitly by the standalone/npm packaging policies.
  // Keep this runtime probe opaque to Next's build tracer so it does not expand
  // a variable filesystem expression into a repository-wide glob.
  return Reflect.apply(fs.existsSync, fs, [candidate]) as boolean;
}

type WorkerResolutionContext = {
  moduleDir?: string;
  cwd?: string;
  entryFile?: string | null;
  fileExists?: (candidate: string) => boolean;
};

export function resolveCallLogArtifactWorker(context: WorkerResolutionContext = {}): {
  workerFile: string;
  execArgv: string[];
} {
  const moduleDir = context.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = context.cwd ?? process.cwd();
  const entryFile = context.entryFile === undefined ? process.argv[1] : context.entryFile;
  const exists = context.fileExists ?? fileExistsAtRuntime;

  const moduleJs = path.join(moduleDir, "callLogArtifactWorker.js");
  if (exists(moduleJs)) return { workerFile: moduleJs, execArgv: [] };

  const entryJs = entryFile
    ? path.join(path.dirname(path.resolve(entryFile)), "src/lib/usage/callLogArtifactWorker.js")
    : null;
  if (entryJs && exists(entryJs)) return { workerFile: entryJs, execArgv: [] };

  const cwdJs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.js");
  if (exists(cwdJs)) return { workerFile: cwdJs, execArgv: [] };

  // Native TypeScript workers avoid esbuild zombies when terminated.
  const moduleTs = path.join(moduleDir, "callLogArtifactWorker.ts");
  if (exists(moduleTs)) {
    return { workerFile: moduleTs, execArgv: [] };
  }

  const cwdTs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.ts");
  if (exists(cwdTs)) {
    return { workerFile: cwdTs, execArgv: [] };
  }

  return { workerFile: entryJs ?? cwdJs, execArgv: [] };
}

function clearIdleTimer(): void {
  if (!state.idleTimer) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function terminateWorker(): void {
  const current = state.worker;
  const instance = state.workerInstance;
  state.worker = null;
  clearIdleTimer();
  // Strings held by this worker die with it.
  dropHeldForInstance(instance);
  if (current) void current.terminate().catch(() => {});
}

function dropHeld(key: number): void {
  const record = state.held.get(key);
  if (!record) return;
  state.held.delete(key);
  state.heldBytes -= record.bytes;
}

function dropHeldForInstance(instance: number): void {
  for (const [key, record] of state.held) {
    if (record.instance === instance) dropHeld(key);
  }
}

function notifyCloseWaiters(): void {
  if (state.active || state.queue.length > 0) return;
  const waiters = state.closeWaiters;
  state.closeWaiters = [];
  for (const resolve of waiters) resolve();
}

function scheduleIdleTermination(): void {
  clearIdleTimer();
  if (!state.worker || state.active || state.queue.length > 0) return;
  // An idle worker must not keep the process alive for IDLE_TIMEOUT_MS after its last write
  // (a CLI or test process would otherwise linger 30 s). pump() refs it again for the next write.
  state.worker.unref();
  // A worker holding detail files for queued rows is not idle: terminating it would lose them.
  // Its rows' write or release job brings the count back to zero and re-arms this timer.
  if (state.held.size > 0) return;
  state.idleTimer = setTimeout(terminateWorker, IDLE_TIMEOUT_MS);
  state.idleTimer.unref?.();
}

function warnRateLimited(message: string): void {
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
  lastWarningAt = now;
  console.warn(message);
}

function describeFailureDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  return String(detail ?? "unknown error");
}

function failOpen(warn = false, detail?: unknown): void {
  if (warn) {
    warnRateLimited(`[callLogs] Call-log artifact worker failed: ${describeFailureDetail(detail)}`);
  }
  const failed = state.active ? [state.active, ...state.queue] : [...state.queue];
  state.active = null;
  state.queue.length = 0;
  terminateWorker();
  for (const item of failed) {
    if (item.heldKey !== undefined) dropHeld(item.heldKey);
    item.resolve(null);
  }
  notifyCloseWaiters();
}

let workerFileOverride: { workerFile: string; execArgv: string[] } | null = null;

/**
 * Test-only hook: force the next ensureWorker() call to spawn an arbitrary worker
 * script/execArgv instead of the real callLogArtifactWorker file. Lets regression tests
 * trigger a genuine worker_threads `error`/`exit` event without editing the production
 * worker script. Never called from production code paths.
 */
export function __setCallLogWorkerOverrideForTests(
  override: { workerFile: string; execArgv: string[] } | null
): void {
  workerFileOverride = override;
}

function ensureWorker(): Worker {
  if (state.worker) return state.worker;

  const { workerFile, execArgv } = workerFileOverride ?? resolveCallLogArtifactWorker();
  // Reflect.construct keeps Next/Turbopack from interpreting the runtime-selected
  // worker path as a build-time glob and tracing tens of thousands of unrelated files.
  const created = Reflect.construct(Worker, [pathToFileURL(workerFile), { execArgv }]) as Worker;
  const instance = state.workerInstance + 1;
  state.worker = created;
  state.workerInstance = instance;
  created.on("message", (reply: WorkerReply) => {
    if (!state.active || reply.id !== state.active.id) return;
    const completed = state.active;
    state.active = null;
    completed.resolve(reply);
    pump();
  });
  created.on("error", (err) => {
    if (state.worker === created) failOpen(true, err);
  });
  created.on("messageerror", (err) => {
    if (state.worker === created) failOpen(true, err);
  });
  created.on("exit", (code) => {
    if (state.worker !== created) return;
    state.worker = null;
    // Even a clean exit loses the strings this worker held.
    dropHeldForInstance(instance);
    if (code !== 0 || state.active) failOpen(true, new Error(`worker exited with code ${code}`));
  });
  return created;
}

function pump(): void {
  if (state.active) return;
  const next = state.queue.shift();
  if (!next) {
    notifyCloseWaiters();
    scheduleIdleTermination();
    return;
  }

  state.active = next;
  clearIdleTimer();
  try {
    const current = ensureWorker();
    if (next.heldKey !== undefined) {
      const record = state.held.get(next.heldKey);
      if (record) record.instance = state.workerInstance;
    }
    // Hold the process open until this job's reply arrives, even if the worker was idle.
    current.ref();
    current.postMessage({ ...next.message, id: next.id });
  } catch (err) {
    failOpen(true, err);
  }
}

function currentEnvironment(): WriteEnvironment {
  return {
    pipelineMaxSizeKb: process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB,
    chatDebugFile: process.env.CHAT_DEBUG_FILE,
    appLogLevel: process.env.APP_LOG_LEVEL,
    // Resolved, not raw: a redirected parent has no DATA_DIR in its env.
    dataDir: resolveWritableDataDir(),
  };
}

function cappedQueueFull(): boolean {
  let capped = 0;
  for (const item of state.queue) if (item.capped) capped++;
  return capped >= MAX_QUEUED_JOBS;
}

function enqueue(item: Omit<QueueItem, "id">): void {
  state.queue.push({ ...item, id: state.nextId++ });
  pump();
}

/** Serialize and write at once; the path used when log batching is off. */
export function writeCallArtifactAsync(
  artifact: CallLogArtifact
): Promise<CallLogArtifactWriteResult | null> {
  if (state.closing || cappedQueueFull()) {
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    enqueue({
      capped: true,
      message: { artifact, environment: currentEnvironment() },
      resolve: (reply) =>
        resolve((reply?.result as CallLogArtifactWriteResult | null | undefined) ?? null),
    });
  });
}

function pendingSerializeBytes(): number {
  if (isChatDebugFileEnabled()) return UNBOUNDED_PENDING_BYTES;
  return Math.max(MAX_CALL_LOG_ARTIFACT_BYTES, getCallLogPipelineMaxSizeBytes());
}

/**
 * Log batching: serialize a row's detail file now, off the request thread, and keep the
 * finished string in the worker until the row is committed. Returns the key to pass to
 * writeHeldCallArtifacts or releaseHeldCallArtifacts, or null when the job was refused (the
 * row then ends `missing`, as a refused write does today). The string counts toward
 * getHeldCallArtifactBytes() until its write or release reply.
 */
export function holdCallArtifact(artifact: CallLogArtifact): number | null {
  if (state.closing || cappedQueueFull()) {
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return null;
  }
  const key = state.nextKey++;
  const estimate = pendingSerializeBytes();
  state.held.set(key, { instance: null, bytes: estimate });
  state.heldBytes += estimate;
  enqueue({
    capped: true,
    message: { kind: "serialize", key, artifact, environment: currentEnvironment() },
    heldKey: key,
    resolve: (reply) => {
      const record = state.held.get(key);
      if (!record) return;
      const size = reply?.sizeBytes;
      if (typeof size !== "number") {
        // Serialization failed (or the job was dropped): nothing is held for this row.
        dropHeld(key);
        return;
      }
      state.heldBytes += size - record.bytes;
      record.bytes = size;
    },
  });
  return key;
}

/** Bytes of detail files held, or being serialized, for rows not yet written or released. */
export function getHeldCallArtifactBytes(): number {
  return state.heldBytes;
}

/** Number of detail files held, or being serialized, for rows not yet written or released. */
export function getHeldCallArtifactCount(): number {
  return state.held.size;
}

/**
 * Writes the held detail files of committed rows, in one worker job. `rowId` is the row's
 * final id when an id collision changed it. Results are in entry order; null ends that row
 * `missing` (lost to a worker failure, failed to write, or refused while closing). Write jobs
 * bypass the serialize cap: a burst of new rows must not strand committed ones.
 */
export function writeHeldCallArtifacts(
  entries: Array<{ key: number; rowId?: string }>
): Promise<Array<CallLogArtifactWriteResult | null>> {
  const live = entries.filter((entry) => state.held.has(entry.key));
  if (state.closing || live.length === 0) {
    for (const entry of entries) dropHeld(entry.key);
    return Promise.resolve(entries.map(() => null));
  }
  return new Promise((resolve) => {
    enqueue({
      capped: false,
      // No environment: the worker writes each entry under the one it was serialized with.
      message: { kind: "write", entries: live },
      resolve: (reply) => {
        const results = Array.isArray(reply?.results)
          ? (reply.results as Array<CallLogArtifactWriteResult | null>)
          : [];
        const byKey = new Map<number, CallLogArtifactWriteResult | null>();
        live.forEach((entry, index) => byKey.set(entry.key, results[index] ?? null));
        for (const entry of entries) dropHeld(entry.key);
        resolve(entries.map((entry) => byKey.get(entry.key) ?? null));
      },
    });
  });
}

/** Frees held detail files whose rows will never be written (dropped batch, closed database). */
export function releaseHeldCallArtifacts(keys: number[]): void {
  const live = keys.filter((key) => state.held.has(key));
  // No worker (or closing): the strings are gone or about to be, with it.
  if (live.length === 0 || state.closing || !state.worker) {
    for (const key of keys) dropHeld(key);
    return;
  }
  // The worker still holds them until it runs this job, so they keep counting until its reply
  // (or until a failure drops them with the worker).
  enqueue({
    capped: false,
    message: { kind: "release", keys: live },
    resolve: () => {
      for (const key of live) dropHeld(key);
    },
  });
}

export async function closeCallLogArtifactWriter(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  state.closing = true;
  if (!state.active && state.queue.length === 0) {
    terminateWorker();
    return;
  }

  if (timeoutMs <= 0) {
    failOpen();
    terminateWorker();
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve) => state.closeWaiters.push(resolve)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (state.active || state.queue.length > 0) failOpen();
  terminateWorker();
}
