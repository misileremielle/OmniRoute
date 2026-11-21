/**
 * Batched writes for the two per-request log tables, `call_logs` and `usage_history`
 * (step-11 fix 3). Each request used to commit its rows one at a time, and every commit
 * rewrote the pages of every index on those tables. Rows are now queued for up to
 * OMNIROUTE_LOG_BATCH_MS (default 5000) or 200 rows, and written in one transaction.
 *
 * - The writers resolve as soon as their row is queued; the steps that need the committed row
 *   (request-persisted marker, detail-file publish, usage event, continuation-bridge clear)
 *   run after the COMMIT, in queue order.
 * - Readers that must see every row (limits, quotas, rollups, "delete all logs") call
 *   flushLogWriteBatchSync() first. A flush never runs inside an open transaction.
 * - One queue per process (#18678: Next.js loads separate module copies).
 * - OMNIROUTE_LOG_BATCH_MS=0 keeps today's one-row-at-a-time path; it is the default in test
 *   processes.
 *
 * @module lib/usage/logWriteBatch
 */

import type { SqliteAdapter } from "../db/adapters/types";
import { getProcessStore } from "@/shared/utils/processSingleton";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";
import {
  getHeldCallArtifactBytes,
  releaseHeldCallArtifacts,
  writeHeldCallArtifacts,
} from "./callLogArtifactWriter";
import type { CallLogArtifactWriteResult } from "./callLogArtifacts";

export const LOG_BATCH_DEFAULT_MS = 5000;
export const LOG_BATCH_MAX_ROWS = 200;
/** Held detail files above this flush the queue early (the memory bound, with one entry more). */
export const LOG_BATCH_MAX_HELD_BYTES = 16 * 1024 * 1024;
/** Delay before the single retry of a batch that met a database lock. */
const LOCK_RETRY_DELAY_MS = 1000;

/** One queued row write and what has to happen around its commit. */
export type LogWriteEntry = {
  /** The handle the row was prepared against (#12780); each handle commits on its own. */
  db: SqliteAdapter;
  /** Runs the row's statements inside the batch transaction. Throws on failure. */
  write: () => void;
  /** Detail file held by the artifact worker for this row, with the row's final id. */
  artifact?: { key: number | null; rowId: () => string };
  /** After the COMMIT, before the detail write: synchronous markers and events. */
  committed?: () => void;
  /** After the detail write (call logs with a detail only): publish or mark missing. */
  published?: (result: CallLogArtifactWriteResult | null) => void;
  /** Last step after a commit, a drop or a close: release in-memory state. */
  settled?: () => void;
  /** The row was not written: its batch was dropped after a lock, or it failed alone. */
  failed: (error: unknown) => void;
};

type QueuedEntry = LogWriteEntry & { done: () => void };

type BatchState = {
  queue: QueuedEntry[];
  timer: NodeJS.Timeout | null;
  flushScheduled: boolean;
  closing: boolean;
  /** After-commit chains and lock retries still running; the shutdown drain waits for them. */
  inFlight: Set<Promise<void>>;
  /** Callers already warned about a skipped flush (one line per caller). */
  skipWarned: Set<string>;
  stats: { flushes: number; rows: number; skippedFlushes: number; droppedRows: number };
};

const state = getProcessStore<BatchState>("logWriteBatch", () => ({
  queue: [],
  timer: null,
  flushScheduled: false,
  closing: false,
  inFlight: new Set(),
  skipWarned: new Set(),
  stats: { flushes: 0, rows: 0, skippedFlushes: 0, droppedRows: 0 },
}));

// The flush timer is unref'd, so a short-lived process (the in-process perf scripts under
// scripts/perf/) could exit with rows queued. `beforeExit` fires once the loop is empty; the
// flush's detail writes keep it alive until they finish. Registered once per process.
const exitHook = getProcessStore("logWriteBatch.beforeExit", () => {
  const listener = () => flushLogWriteBatchSync("beforeExit");
  process.on("beforeExit", listener);
  return listener;
});
void exitHook;

/**
 * The batch window in ms; 0 means no batching. Read on every queue so tests can set it.
 * Strict digits only; anything else falls back to the default. Test processes default to 0.
 */
export function getLogBatchMs(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv
): number {
  const raw = env.OMNIROUTE_LOG_BATCH_MS;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return isAutomatedTestProcess(argv, env, execArgv) ? 0 : LOG_BATCH_DEFAULT_MS;
}

/** True when new log rows should be queued rather than written at once. */
export function isLogBatchingActive(): boolean {
  return !state.closing && getLogBatchMs() > 0;
}

function track(promise: Promise<void>): void {
  state.inFlight.add(promise);
  void promise.finally(() => state.inFlight.delete(promise));
}

/**
 * Queues one row. Returns a promise that settles once the row's after-commit steps (or its
 * failure handling) have run; the writers do not wait for it, the shutdown drain and tests do.
 */
export function queueLogWrite(entry: LogWriteEntry): Promise<void> {
  let done!: () => void;
  const settled = new Promise<void>((resolve) => {
    done = resolve;
  });
  track(settled);
  state.queue.push({ ...entry, done });

  if (
    state.queue.length >= LOG_BATCH_MAX_ROWS ||
    getHeldCallArtifactBytes() >= LOG_BATCH_MAX_HELD_BYTES
  ) {
    scheduleImmediateFlush();
  } else if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      flushLogWriteBatchSync("timer");
    }, getLogBatchMs());
    state.timer.unref?.();
  }
  return settled;
}

// Off the writer's call stack: the writer may be running inside its caller's transaction.
function scheduleImmediateFlush(): void {
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  const handle = setImmediate(() => {
    state.flushScheduled = false;
    flushLogWriteBatchSync("size");
  });
  handle.unref?.();
}

function clearTimer(): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

/** Number of rows queued and not yet committed. */
export function getQueuedLogWriteCount(): number {
  return state.queue.length;
}

/** Number of rows queued or committed whose after-commit steps have not finished. */
export function getInFlightLogWriteCount(): number {
  return state.inFlight.size;
}

export function getLogWriteBatchStats(): Readonly<BatchState["stats"]> {
  return { ...state.stats };
}

type FlushOptions = {
  /** Only this handle's rows (close/reset); others stay queued. */
  db?: SqliteAdapter;
  /** False on close: rows are committed but their detail files are released, not written. */
  publish?: boolean;
};

/**
 * Writes the queued rows now, one transaction per database handle. Synchronous, so readers can
 * call it right before their query. Does nothing for a handle that is inside a transaction
 * (its rows stay queued): the flush would otherwise commit or roll back with the caller's work.
 * `caller` names the reader in the one-time warning for a skipped flush.
 */
export function flushLogWriteBatchSync(caller = "reader", options: FlushOptions = {}): void {
  if (state.queue.length === 0) return;
  const target = options.db;
  const taken = target ? state.queue.filter((e) => e.db === target) : state.queue.slice();
  if (taken.length === 0) return;
  const kept = target ? state.queue.filter((e) => e.db !== target) : [];
  state.queue = kept;
  if (state.queue.length === 0) clearTimer();

  const groups = new Map<SqliteAdapter, QueuedEntry[]>();
  for (const entry of taken) {
    const group = groups.get(entry.db);
    if (group) group.push(entry);
    else groups.set(entry.db, [entry]);
  }
  const requeue: QueuedEntry[] = [];
  for (const [db, entries] of groups) {
    if (!db.open) {
      // The handle closed without a flush (should not happen: close and reset flush first).
      dropEntries(entries, new Error("database handle closed before the log batch was written"));
      continue;
    }
    // `undefined` means the driver cannot tell: treat it as inside a transaction.
    if (db.inTransaction !== false) {
      state.stats.skippedFlushes++;
      if (!state.skipWarned.has(caller)) {
        state.skipWarned.add(caller);
        console.warn(
          `[logWriteBatch] Flush skipped inside an open transaction (caller: ${caller}); ` +
            `${entries.length} log rows stay queued.`
        );
      }
      requeue.push(...entries);
      continue;
    }
    commitGroup(db, entries, options.publish !== false, 0);
  }
  if (requeue.length > 0) requeueFront(requeue);
}

/**
 * Puts rows back ahead of anything queued meanwhile (queue order holds) and makes sure a flush
 * timer is armed, so they are written even if no other row or reader comes.
 */
function requeueFront(entries: QueuedEntry[]): void {
  state.queue = [...entries, ...state.queue];
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flushLogWriteBatchSync("timer");
  }, getLogBatchMs() || LOG_BATCH_DEFAULT_MS);
  state.timer.unref?.();
}

// Same rules as isWriteLockError (usageWriteRetry.ts). Not imported: that module imports
// db/core, and db/core imports this one (close and reset flush first).
function isLockError(error: unknown): boolean {
  const details = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = details?.code ?? details?.errcode;
  if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code)) return true;
  if (typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6)) return true;
  const message = error instanceof Error ? error.message : String(details?.message ?? error);
  return /database(?: table| schema)? is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

function rollbackQuietly(db: SqliteAdapter): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The failed statement may already have ended the transaction.
  }
}

/** One plain transaction for the group; no per-row savepoints on the normal path. */
function commitGroup(
  db: SqliteAdapter,
  entries: QueuedEntry[],
  publish: boolean,
  attempt: number
): void {
  let committedEntries: QueuedEntry[] = entries;
  const failedAlone: Array<[QueuedEntry, unknown]> = [];
  try {
    db.exec("BEGIN");
    try {
      for (const entry of entries) entry.write();
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      if (isLockError(error)) throw error;
      // A row failed for another reason: replay row by row, each in its own savepoint, so
      // only the bad row is lost (rare; not on the measured path).
      committedEntries = [];
      db.exec("BEGIN");
      try {
        for (const entry of entries) {
          db.exec("SAVEPOINT log_write_row");
          try {
            entry.write();
            db.exec("RELEASE log_write_row");
            committedEntries.push(entry);
          } catch (rowError) {
            db.exec("ROLLBACK TO log_write_row");
            db.exec("RELEASE log_write_row");
            if (isLockError(rowError)) throw rowError;
            failedAlone.push([entry, rowError]);
          }
        }
        db.exec("COMMIT");
      } catch (replayError) {
        rollbackQuietly(db);
        throw replayError;
      }
    }
  } catch (error) {
    if (isLockError(error) && attempt === 0) {
      scheduleLockRetry(db, entries, publish);
      return;
    }
    if (isLockError(error)) {
      console.error(
        `[logWriteBatch] Dropped ${entries.length} log rows after a database lock:`,
        error
      );
    }
    dropEntries(entries, error);
    return;
  }

  state.stats.flushes++;
  state.stats.rows += committedEntries.length;
  for (const [entry, error] of failedAlone) failEntry(entry, error);
  track(runAfterCommit(committedEntries, publish));
}

function scheduleLockRetry(db: SqliteAdapter, entries: QueuedEntry[], publish: boolean): void {
  const retry = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (!db.open) {
          dropEntries(entries, new Error("database handle closed before the log batch retry"));
        } else if (db.inTransaction !== false) {
          // Back into the queue; the next flush outside a transaction writes them.
          requeueFront(entries);
        } else {
          commitGroup(db, entries, publish, 1);
        }
      } finally {
        resolve();
      }
    }, LOCK_RETRY_DELAY_MS);
    timer.unref?.();
  });
  track(retry);
}

function failEntry(entry: QueuedEntry, error: unknown): void {
  try {
    if (entry.artifact?.key != null) releaseHeldCallArtifacts([entry.artifact.key]);
    entry.failed(error);
  } catch (hookError) {
    console.error("[logWriteBatch] Failure handler failed:", hookError);
  }
  settleEntry(entry);
}

function dropEntries(entries: QueuedEntry[], error: unknown): void {
  state.stats.droppedRows += entries.length;
  for (const entry of entries) failEntry(entry, error);
}

function settleEntry(entry: QueuedEntry): void {
  try {
    entry.settled?.();
  } catch (error) {
    console.error("[logWriteBatch] Settle handler failed:", error);
  }
  entry.done();
}

function runHook(name: string, hook: () => void): void {
  try {
    hook();
  } catch (error) {
    console.error(`[logWriteBatch] After-commit step "${name}" failed:`, error);
  }
}

async function runAfterCommit(entries: QueuedEntry[], publish: boolean): Promise<void> {
  for (const entry of entries) {
    if (entry.committed) runHook("committed", entry.committed);
  }

  const withDetail = entries.filter((entry) => entry.artifact);
  if (!publish) {
    // Close/reset: the rows stay pending in the old file; free their held files.
    const keys = withDetail
      .map((entry) => entry.artifact?.key)
      .filter((key): key is number => typeof key === "number");
    if (keys.length > 0) releaseHeldCallArtifacts(keys);
  } else if (withDetail.length > 0) {
    // One worker job per flush for every detail file of the batch.
    const live = withDetail.filter((entry) => typeof entry.artifact?.key === "number");
    let results: Array<CallLogArtifactWriteResult | null> = [];
    try {
      results = await writeHeldCallArtifacts(
        live.map((entry) => ({
          key: entry.artifact!.key as number,
          rowId: entry.artifact!.rowId(),
        }))
      );
    } catch (error) {
      console.error("[logWriteBatch] Detail write failed:", error);
    }
    const byEntry = new Map<QueuedEntry, CallLogArtifactWriteResult | null>();
    live.forEach((entry, index) => byEntry.set(entry, results[index] ?? null));
    for (const entry of withDetail) {
      if (entry.published) runHook("published", () => entry.published!(byEntry.get(entry) ?? null));
    }
  }

  for (const entry of entries) settleEntry(entry);
}

/**
 * Shutdown: stop queueing (later rows take the direct path), write what is queued, and wait up
 * to `timeoutMs` for the after-commit steps. Returns false when they did not all finish.
 */
export async function drainLogWriteBatch(timeoutMs: number): Promise<boolean> {
  state.closing = true;
  clearTimer();
  flushLogWriteBatchSync("shutdown");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (state.inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await nextProgress(remaining);
    // Rows re-queued meanwhile (a lock retry, a skipped flush) are written on the next pass;
    // the in-flight set also holds queued rows, so waiting for all of it would stall on them.
    flushLogWriteBatchSync("shutdown");
  }
  return true;
}

/**
 * Resolves when any of `pending` (default: every in-flight step) settles, or after `maxMs`
 * (at most 100 ms).
 */
async function nextProgress(
  maxMs: number,
  pending: Set<Promise<void>> = state.inFlight
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.race([...pending]).then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, Math.min(maxMs, 100));
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

/**
 * Flushes, then waits (up to `timeoutMs`) for the work that was in flight at that moment:
 * after-commit steps such as detail-file writes, and lock retries. Rows queued later are not
 * waited for, so steady traffic cannot hold the caller. For callers that delete what those
 * steps write (purging call logs and their artifact files). Returns false on timeout.
 */
export async function flushLogWriteBatchAndSettle(
  caller: string,
  timeoutMs = 5000
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  flushLogWriteBatchSync(caller);
  const pending = new Set(state.inFlight);
  for (const promise of pending) void promise.finally(() => pending.delete(promise));
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await nextProgress(remaining, pending);
    // A lock retry puts its rows back in the queue behind the window timer: write them now.
    flushLogWriteBatchSync(caller);
  }
  return true;
}

/** Waits for every queued row to be committed and its after-commit steps to finish (tests). */
export async function waitForLogWriteBatch(): Promise<void> {
  flushLogWriteBatchSync("wait");
  while (state.inFlight.size > 0) {
    await nextProgress(100);
    flushLogWriteBatchSync("wait");
  }
}

/** Test hook: forget queued rows and counters, reopen after a drain. */
export function resetLogWriteBatchForTests(): void {
  clearTimer();
  state.queue = [];
  state.closing = false;
  state.flushScheduled = false;
  state.inFlight.clear();
  state.skipWarned.clear();
  state.stats = { flushes: 0, rows: 0, skippedFlushes: 0, droppedRows: 0 };
}
