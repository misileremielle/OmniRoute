// Step-11 fix 3: call_logs and usage_history rows are queued and committed together. These
// tests run with batching on (an explicit OMNIROUTE_LOG_BATCH_MS beats the test-process default).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-log-write-batch-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_LOG_BATCH_MS = "5000";

const core = await import("../../src/lib/db/core.ts");
const batch = await import("../../src/lib/usage/logWriteBatch.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const store = await import("../../src/lib/db/responsesContinuationStore.ts");
const artifactWriter = await import("../../src/lib/usage/callLogArtifactWriter.ts");
const tokenLimits = await import("../../open-sse/services/tokenLimitCounter.ts");
const cleanup = await import("../../src/lib/db/cleanup.ts");
const resilience = await import("../../src/lib/usage/resilienceActionsContext.ts");
const { openMemorySqliteAdapter } = await import("./_helpers/memorySqliteAdapter.ts");

function artifactFiles(): string[] {
  const root = path.join(TEST_DATA_DIR, "call_logs");
  if (!fs.existsSync(root)) return [];
  return (fs.readdirSync(root, { recursive: true }) as string[]).filter((name) =>
    fs.statSync(path.join(root, name)).isFile()
  );
}

test.after(async () => {
  await artifactWriter.closeCallLogArtifactWriter();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(async () => {
  await batch.waitForLogWriteBatch();
  batch.resetLogWriteBatchForTests();
});

const db = () => core.getDbInstance();
const count = (sql: string, ...params: unknown[]) =>
  Number(
    (
      db()
        .prepare(sql)
        .get(...params) as { n: number }
    ).n
  );

function usageEntry(model: string) {
  return {
    provider: "openai",
    model,
    tokens: { input: 3, output: 4 },
    status: "200",
    success: true,
    latencyMs: 5,
    endpoint: "/v1/chat/completions",
  };
}

function callLogEntry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 10,
    tokens: { in: 1, out: 1 },
    requestBody: { prompt: "hi" },
    responseBody: { content: "ok" },
    ...extra,
  };
}

test("the setting: digits only, 0 = off, test processes default to 0", () => {
  const server = ["node", "/srv/omniroute/server.js"];
  const prod = (raw?: string) =>
    batch.getLogBatchMs(
      raw === undefined
        ? { NODE_ENV: "production" }
        : { NODE_ENV: "production", OMNIROUTE_LOG_BATCH_MS: raw },
      server,
      []
    );
  assert.equal(prod(), 5000, "a production server batches by default");
  assert.equal(prod("0"), 0);
  assert.equal(prod("250"), 250);
  assert.equal(prod("5e3"), 5000, "not digits: the default");
  assert.equal(prod("-1"), 5000);
  assert.equal(batch.getLogBatchMs({}, server, ["--test"]), 0, "node --test");
  assert.equal(batch.getLogBatchMs({ NODE_ENV: "test" }, server, []), 0);
  assert.equal(batch.getLogBatchMs({ VITEST: "true" }, server, []), 0);
  assert.equal(batch.getLogBatchMs({ OMNIROUTE_LOG_BATCH_MS: "7" }, server, ["--test"]), 7);
  assert.equal(batch.isLogBatchingActive(), true, "this file sets 5000 explicitly");
});

test("usage rows wait in the queue and are written by one flush in one transaction", async () => {
  const before = count("SELECT COUNT(*) AS n FROM usage_history");
  for (let i = 0; i < 5; i++) await usageHistory.saveRequestUsage(usageEntry(`batch-m-${i}`));
  assert.equal(batch.getQueuedLogWriteCount(), 5, "the writer resolved with the row queued");
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history"), before, "nothing written yet");

  const handle = db();
  const execs: string[] = [];
  let transactions = 0;
  const originalExec = handle.exec;
  const originalTransaction = handle.transaction;
  handle.exec = (sql: string) => {
    execs.push(sql);
    return originalExec.call(handle, sql);
  };
  handle.transaction = ((fn: (...args: unknown[]) => unknown) => {
    transactions++;
    return originalTransaction.call(handle, fn);
  }) as typeof handle.transaction;
  try {
    batch.flushLogWriteBatchSync("test");
  } finally {
    handle.exec = originalExec;
    handle.transaction = originalTransaction;
  }
  assert.deepEqual(execs, ["BEGIN", "COMMIT"], "one plain transaction, no per-row savepoints");
  assert.equal(transactions, 0, "no db.transaction() (it would nest as a savepoint pair)");
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history"), before + 5);
  assert.equal(batch.getQueuedLogWriteCount(), 0);
});

test("one flush of n usage rows and m call logs runs exactly the expected statements", async () => {
  const n = 3;
  const m = 2;
  const stamp = Date.now();
  for (let i = 0; i < n; i++) {
    await usageHistory.saveRequestUsage({
      ...usageEntry(`count-u-${i}`),
      timestamp: new Date(stamp + i).toISOString(),
    });
  }
  for (let i = 0; i < m; i++) await callLogs.saveCallLog(callLogEntry(`count-c-${i}`));
  assert.equal(batch.getQueuedLogWriteCount(), n + m);

  const handle = db();
  const prepared: string[] = [];
  const execs: string[] = [];
  const originalPrepare = handle.prepare;
  const originalExec = handle.exec;
  handle.prepare = ((sql: string) => {
    prepared.push(sql.replace(/\s+/g, " ").trim());
    return originalPrepare.call(handle, sql);
  }) as typeof handle.prepare;
  handle.exec = (sql: string) => {
    execs.push(sql);
    return originalExec.call(handle, sql);
  };
  try {
    batch.flushLogWriteBatchSync("count");
  } finally {
    handle.prepare = originalPrepare;
    handle.exec = originalExec;
  }
  const kind = (sql: string) =>
    sql.startsWith("INSERT INTO usage_history")
      ? "usage insert"
      : sql.startsWith("INSERT INTO call_logs")
        ? "call log insert"
        : sql.startsWith("SELECT id, endpoint, cpa_auth_index FROM usage_history")
          ? "duplicate check"
          : `other: ${sql.slice(0, 80)}`;
  const tally = new Map<string, number>();
  for (const sql of prepared) tally.set(kind(sql), (tally.get(kind(sql)) ?? 0) + 1);
  assert.deepEqual(
    Object.fromEntries(tally),
    { "duplicate check": n, "usage insert": n, "call log insert": m },
    "n duplicate checks, n + m inserts, nothing else"
  );
  assert.deepEqual(execs, ["BEGIN", "COMMIT"], "one BEGIN, one COMMIT");
  assert.ok(
    [...prepared, ...execs].every((sql) => !/SAVEPOINT|RELEASE/i.test(sql)),
    "no savepoints"
  );
  await batch.waitForLogWriteBatch();
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model LIKE 'count-u-%'"), n);
  assert.equal(count("SELECT COUNT(*) AS n FROM call_logs WHERE id LIKE 'count-c-%'"), m);
});

test("rows on two database handles are each written to their own handle", () => {
  const handles = [openMemorySqliteAdapter(), openMemorySqliteAdapter()];
  const execs: string[][] = [[], []];
  const seenInTransaction: boolean[][] = [[], []];
  handles.forEach((h, index) => {
    h.exec("CREATE TABLE lw_two (v INTEGER)");
    const originalExec = h.exec;
    h.exec = (sql: string) => {
      execs[index].push(sql);
      return originalExec.call(h, sql);
    };
  });
  const queue = (index: number, v: number) => {
    const h = handles[index];
    void batch.queueLogWrite({
      db: h,
      write: () => {
        seenInTransaction[index].push(h.inTransaction === true);
        h.prepare("INSERT INTO lw_two (v) VALUES (?)").run(v);
      },
      failed: () => assert.fail("not dropped"),
    });
  };
  const values = (h: (typeof handles)[number]) =>
    (h.prepare("SELECT v FROM lw_two ORDER BY v").all() as Array<{ v: number }>).map((r) => r.v);
  try {
    // One flush with both handles' rows interleaved: one transaction per handle.
    queue(0, 1);
    queue(1, 2);
    queue(0, 3);
    queue(1, 4);
    batch.flushLogWriteBatchSync("two handles");
    assert.deepEqual(values(handles[0]), [1, 3]);
    assert.deepEqual(values(handles[1]), [2, 4]);
    assert.deepEqual(execs, [
      ["BEGIN", "COMMIT"],
      ["BEGIN", "COMMIT"],
    ]);
    assert.deepEqual(
      seenInTransaction,
      [
        [true, true],
        [true, true],
      ],
      "each row is written inside its own handle's transaction"
    );

    // A flush for one handle (close/reset) leaves the other handle's rows queued.
    queue(0, 5);
    queue(1, 6);
    batch.flushLogWriteBatchSync("one handle", { db: handles[1] });
    assert.equal(batch.getQueuedLogWriteCount(), 1);
    assert.deepEqual(values(handles[0]), [1, 3]);
    assert.deepEqual(values(handles[1]), [2, 4, 6]);
    batch.flushLogWriteBatchSync("the rest");
    assert.deepEqual(values(handles[0]), [1, 3, 5]);
  } finally {
    for (const h of handles) h.close();
  }
});

test("a duplicate queued in the same batch is still found", async () => {
  const entry = { ...usageEntry("dupe-model"), timestamp: "2026-11-20T00:00:00.000Z" };
  await usageHistory.saveRequestUsage(entry);
  await usageHistory.saveRequestUsage(entry);
  await batch.waitForLogWriteBatch();
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'dupe-model'"), 1);
});

test("a call log is published after the commit: row ready and detail file written", async () => {
  await callLogs.saveCallLog(callLogEntry("batched-call-1"));
  assert.equal(count("SELECT COUNT(*) AS n FROM call_logs WHERE id = 'batched-call-1'"), 0);
  await batch.waitForLogWriteBatch();
  const row = db()
    .prepare("SELECT detail_state, artifact_relpath FROM call_logs WHERE id = ?")
    .get("batched-call-1") as { detail_state: string; artifact_relpath: string };
  assert.equal(row.detail_state, "ready");
  assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath)));
  assert.equal(artifactWriter.getHeldCallArtifactCount(), 0);
});

test("an id collision inside a flush publishes the file under the new id (#14451)", async () => {
  await callLogs.saveCallLog(callLogEntry("collide-1"));
  await batch.waitForLogWriteBatch();
  await callLogs.saveCallLog(
    callLogEntry("collide-1", {
      correlationId: "collide-second",
      responseBody: { content: "second" },
    })
  );
  await batch.waitForLogWriteBatch();
  const second = db()
    .prepare("SELECT id, artifact_relpath FROM call_logs WHERE correlation_id = 'collide-second'")
    .get() as { id: string; artifact_relpath: string | null } | undefined;
  assert.ok(second, "the second row was written");
  assert.notEqual(second.id, "collide-1", "with a fresh id");
  assert.ok(second.artifact_relpath!.includes(second.id), "its path carries the new id");
  const written = JSON.parse(
    fs.readFileSync(path.join(TEST_DATA_DIR, "call_logs", second.artifact_relpath!), "utf8")
  );
  assert.equal(written.summary.id, second.id);
  assert.deepEqual(written.responseBody, { content: "second" });
});

test("the continuation bridge serves previous_response_id until the row is ready", async () => {
  const PIPELINE = {
    clientRawRequest: { body: { input: [{ type: "message", role: "user", content: "q" }] } },
    clientResponse: { output: [{ type: "message", role: "assistant", content: "a" }] },
  };
  store.seedPendingContinuationState("resp-batched", "key-batch", PIPELINE, false);
  await callLogs.saveCallLog(
    callLogEntry("bridge-1", {
      responseId: "resp-batched",
      apiKeyId: "key-batch",
      pipeline: PIPELINE,
    })
  );
  assert.ok(
    store.resolvePreviousResponseState("resp-batched", "key-batch"),
    "queued, not yet ready: the bridge answers"
  );
  assert.equal(store.getPendingContinuationStateCount(), 1);
  await batch.waitForLogWriteBatch();
  assert.equal(store.getPendingContinuationStateCount(), 0, "cleared after the publish");
  assert.ok(store.resolvePreviousResponseState("resp-batched", "key-batch"), "the row answers");
});

test("a flush inside an open transaction does nothing; rows stay queued and warn once", async () => {
  await usageHistory.saveRequestUsage(usageEntry("in-tx"));
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(String(message));
  try {
    db().transaction(() => {
      batch.flushLogWriteBatchSync("outer-tx");
      batch.flushLogWriteBatchSync("outer-tx");
    })();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(batch.getQueuedLogWriteCount(), 1);
  assert.equal(batch.getLogWriteBatchStats().skippedFlushes, 2);
  assert.equal(warnings.filter((w) => w.includes("outer-tx")).length, 1);
  batch.flushLogWriteBatchSync("after");
  assert.equal(batch.getQueuedLogWriteCount(), 0);
});

test("a rolled-back outer transaction loses no queued row", async () => {
  await usageHistory.saveRequestUsage(usageEntry("rolled-back-outer"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.throws(
      () =>
        db().transaction(() => {
          batch.flushLogWriteBatchSync("rollback-outer");
          throw new Error("caller rolls back");
        })(),
      /caller rolls back/
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(batch.getQueuedLogWriteCount(), 1, "still queued after the rollback");
  batch.flushLogWriteBatchSync("after rollback");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'rolled-back-outer'"),
    1
  );
});

test("the guard holds under node:sqlite adapter.transaction()", () => {
  const h = openMemorySqliteAdapter();
  assert.equal(h.driver, "node:sqlite");
  try {
    h.exec("CREATE TABLE lw_node (v INTEGER)");
    void batch.queueLogWrite({
      db: h,
      write: () => h.prepare("INSERT INTO lw_node (v) VALUES (1)").run(),
      failed: () => assert.fail("not dropped"),
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      h.transaction(() => {
        batch.flushLogWriteBatchSync("node-sqlite-tx");
        assert.equal(batch.getQueuedLogWriteCount(), 1, "skipped inside the transaction");
      })();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(batch.getLogWriteBatchStats().skippedFlushes, 1);
    batch.flushLogWriteBatchSync("after node-sqlite-tx");
    assert.equal(
      Number((h.prepare("SELECT COUNT(*) AS n FROM lw_node").get() as { n: number }).n),
      1
    );
  } finally {
    h.close();
  }
});

test("an adapter that reports inTransaction undefined is skipped", () => {
  void batch.queueLogWrite({
    db: { open: true, inTransaction: undefined } as unknown as ReturnType<typeof db>,
    write: () => assert.fail("must not be written"),
    failed: () => assert.fail("must not be dropped"),
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    batch.flushLogWriteBatchSync("undefined-flag");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(batch.getQueuedLogWriteCount(), 1);
  assert.equal(batch.getLogWriteBatchStats().skippedFlushes, 1);
  batch.resetLogWriteBatchForTests();
});

test("a flush resets only the writer's own resilience actions", async () => {
  // Request A queues its row (with its summary); a reader in request B then flushes it. The
  // flush must not reset B's store (the row's own reset ran at queue time, in A's context).
  await resilience.runWithResilienceActionsContext(async () => {
    resilience.noteResilienceAction({ rotations: 2 });
    await callLogs.saveCallLog(callLogEntry("resilience-a"));
  });
  assert.equal(batch.getQueuedLogWriteCount(), 1);
  let inB: unknown = null;
  await resilience.runWithResilienceActionsContext(async () => {
    resilience.noteResilienceAction({ rotations: 5 });
    batch.flushLogWriteBatchSync("reader in B");
    inB = resilience.readResilienceActions();
  });
  assert.deepEqual(inB, { rotations: 5 }, "B's actions survive a flush run inside B");
  await batch.waitForLogWriteBatch();
  const row = db()
    .prepare("SELECT resilience_actions FROM call_logs WHERE id = 'resilience-a'")
    .get() as { resilience_actions: string | null };
  assert.deepEqual(JSON.parse(String(row.resilience_actions)), { rotations: 2 });
});

test("resetDbInstance flushes first; no row reaches the replacement handle", async () => {
  await usageHistory.saveRequestUsage(usageEntry("before-reset"));
  assert.equal(batch.getQueuedLogWriteCount(), 1);
  core.resetDbInstance();
  assert.equal(batch.getQueuedLogWriteCount(), 0, "written before the close");
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'before-reset'"), 1);

  // A row bound to the closed handle is dropped, never written to the new one.
  const closed = openMemorySqliteAdapter();
  closed.close();
  let failed = 0;
  void batch.queueLogWrite({
    db: closed,
    write: () => assert.fail("must not run"),
    failed: () => failed++,
  });
  batch.flushLogWriteBatchSync("after reset");
  assert.equal(failed, 1);
  assert.equal(batch.getLogWriteBatchStats().droppedRows, 1);
});

test("rows put back by a skipped flush are written by a new timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await usageHistory.saveRequestUsage(usageEntry("requeued-timer"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // The window timer fires inside a transaction: the flush clears it and skips.
    db().transaction(() => t.mock.timers.tick(5000))();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(batch.getQueuedLogWriteCount(), 1, "skipped, still queued");
  t.mock.timers.tick(5000);
  assert.equal(batch.getQueuedLogWriteCount(), 0, "a new timer wrote it");
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'requeued-timer'"), 1);
});

test("an empty queue inside a transaction counts no skipped flush", () => {
  db().transaction(() => batch.flushLogWriteBatchSync("empty"))();
  assert.equal(batch.getLogWriteBatchStats().skippedFlushes, 0);
});

function scratchTable() {
  db().exec("CREATE TABLE IF NOT EXISTS lw_scratch (v INTEGER)");
  db().exec("DELETE FROM lw_scratch");
}

const lockError = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

test("a lock aborts the batch, which is retried once and then committed", async () => {
  scratchTable();
  let attempts = 0;
  let committed = 0;
  void batch.queueLogWrite({
    db: db(),
    write: () => {
      if (attempts++ === 0) throw lockError();
      db().prepare("INSERT INTO lw_scratch (v) VALUES (1)").run();
    },
    committed: () => committed++,
    failed: () => assert.fail("not dropped"),
  });
  batch.flushLogWriteBatchSync("test");
  assert.equal(count("SELECT COUNT(*) AS n FROM lw_scratch"), 0);
  await batch.waitForLogWriteBatch();
  assert.equal(count("SELECT COUNT(*) AS n FROM lw_scratch"), 1);
  assert.equal(committed, 1);
});

test("a second lock drops the batch and logs it", async () => {
  const failures: unknown[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 2; i++) {
      void batch.queueLogWrite({
        db: db(),
        write: () => {
          throw lockError();
        },
        failed: (error) => failures.push(error),
      });
    }
    await batch.waitForLogWriteBatch();
  } finally {
    console.error = originalError;
  }
  assert.equal(failures.length, 2);
  assert.equal(batch.getLogWriteBatchStats().droppedRows, 2);
});

test("a row failing for another reason is replayed alone; the others commit", async () => {
  scratchTable();
  const failed: number[] = [];
  for (const v of [1, 2, 3]) {
    void batch.queueLogWrite({
      db: db(),
      write: () => {
        if (v === 2) throw new Error("constraint failed");
        db().prepare("INSERT INTO lw_scratch (v) VALUES (?)").run(v);
      },
      failed: () => failed.push(v),
    });
  }
  await batch.waitForLogWriteBatch();
  assert.deepEqual(
    (db().prepare("SELECT v FROM lw_scratch ORDER BY v").all() as Array<{ v: number }>).map(
      (r) => r.v
    ),
    [1, 3]
  );
  assert.deepEqual(failed, [2]);
});

test("rows are written at 200 without waiting for the window", async () => {
  scratchTable();
  for (let i = 0; i < batch.LOG_BATCH_MAX_ROWS; i++) {
    void batch.queueLogWrite({
      db: db(),
      write: () => db().prepare("INSERT INTO lw_scratch (v) VALUES (?)").run(i),
      failed: () => {},
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batch.getQueuedLogWriteCount(), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM lw_scratch"), batch.LOG_BATCH_MAX_ROWS);
});

test("two module copies share one queue and one exit hook", async () => {
  const listeners = process.listenerCount("beforeExit");
  const copy = await import("../../src/lib/usage/logWriteBatch.ts?copy=second");
  assert.equal(process.listenerCount("beforeExit"), listeners, "no second exit hook");
  scratchTable();
  void copy.queueLogWrite({
    db: db(),
    write: () => db().prepare("INSERT INTO lw_scratch (v) VALUES (7)").run(),
    failed: () => {},
  });
  assert.equal(batch.getQueuedLogWriteCount(), 1, "seen through the first copy");
  batch.flushLogWriteBatchSync("first copy");
  assert.equal(copy.getQueuedLogWriteCount(), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM lw_scratch WHERE v = 7"), 1);
});

// Until every serialize reply is in. Before its reply an entry counts as a 512 KB estimate;
// these artifacts are ~1 KB each, so held bytes below one estimate mean none is left. A looser
// bound (count x 64 KB) let ~count/8 estimates through, and with slow replies 20 more saves
// crossed 16 MB and flushed early (the intended trigger, not what this test is about).
async function untilSerialized() {
  const deadline = Date.now() + 10_000;
  while (artifactWriter.getHeldCallArtifactBytes() >= 512 * 1024) {
    assert.ok(Date.now() < deadline, "serialize replies did not all arrive within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("more than 128 queued call logs all get their detail file (paced saves)", async () => {
  const total = 150;
  for (let i = 0; i < total; i++) {
    await callLogs.saveCallLog(callLogEntry(`many-${i}`));
    // Like real traffic: let serialize replies come back before 32 estimates reach 16 MB.
    if (i % 20 === 19) await untilSerialized();
  }
  assert.equal(artifactWriter.getHeldCallArtifactCount(), total, "none refused");
  assert.equal(batch.getQueuedLogWriteCount(), total);
  await batch.waitForLogWriteBatch();
  const rows = db()
    .prepare("SELECT detail_state, artifact_relpath FROM call_logs WHERE id LIKE 'many-%'")
    .all() as Array<{ detail_state: string; artifact_relpath: string }>;
  assert.equal(rows.length, total);
  assert.equal(rows.filter((r) => r.detail_state === "ready").length, total);
  for (const row of rows) {
    assert.ok(fs.existsSync(path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath)));
  }
});

test("a second batch is written early once held detail files reach 16 MB", async () => {
  await callLogs.saveCallLog(callLogEntry("first-batch"));
  batch.flushLogWriteBatchSync("first batch");
  await batch.waitForLogWriteBatch();
  const flushes = batch.getLogWriteBatchStats().flushes;
  // Until the worker replies, each held file counts as 512 KB: 32 of them reach 16 MB.
  for (let i = 0; i < 40; i++) void callLogs.saveCallLog(callLogEntry(`early-${i}`));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(batch.getLogWriteBatchStats().flushes > flushes, "flushed before the window");
  assert.ok(batch.getQueuedLogWriteCount() < 40);
  await batch.waitForLogWriteBatch();
  assert.equal(count("SELECT COUNT(*) AS n FROM call_logs WHERE id LIKE 'early-%'"), 40);
});

test("recording tokens for a key without limits does not flush", async () => {
  await usageHistory.saveRequestUsage(usageEntry("no-limit-key"));
  tokenLimits.recordTokenUsage("key-without-limits", "openai", "m", 100);
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batch.getQueuedLogWriteCount(), 1);
});

test("a queued call log does not keep its request entry alive", async () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  let ref: WeakRef<object> | null = null;
  await (async () => {
    const body = { big: "x".repeat(1024 * 1024) };
    ref = new WeakRef(body);
    await callLogs.saveCallLog(callLogEntry("gc-1", { requestBody: body }));
  })();
  // The serialize job holds the artifact until the worker's reply; give it real time.
  for (let i = 0; i < 10 && ref!.deref() !== undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    gc();
  }
  assert.ok(batch.getQueuedLogWriteCount() >= 1, "the row is still queued");
  assert.equal(ref!.deref(), undefined, "the request body was released");
});

test("closeDbInstance commits the handle's rows and releases their detail files", async () => {
  await callLogs.saveCallLog(callLogEntry("close-1"));
  core.closeDbInstance();
  assert.equal(batch.getQueuedLogWriteCount(), 0);
  assert.equal(
    count("SELECT COUNT(*) AS n FROM call_logs WHERE id = 'close-1' AND detail_state = 'pending'"),
    1,
    "committed, not published"
  );
  const deadline = Date.now() + 5000;
  while (artifactWriter.getHeldCallArtifactCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(artifactWriter.getHeldCallArtifactCount(), 0);
});

test("purging call logs waits for queued detail files, so none reappears", async () => {
  for (let i = 0; i < 3; i++) await callLogs.saveCallLog(callLogEntry(`purge-${i}`));
  assert.ok(artifactWriter.getHeldCallArtifactCount() >= 1, "detail files are held");
  await cleanup.purgeCallLogs();
  await batch.waitForLogWriteBatch();
  assert.equal(count("SELECT COUNT(*) AS n FROM call_logs"), 0);
  assert.deepEqual(artifactFiles(), [], "no detail file written after the purge");
});

test("purging call logs deletes nothing and throws when queued writes do not settle", async () => {
  await callLogs.saveCallLog(callLogEntry("kept-1"));
  await batch.waitForLogWriteBatch();
  // A handle that always reports an open transaction: its row can never be flushed.
  void batch.queueLogWrite({
    db: { open: true, inTransaction: true } as unknown as ReturnType<typeof db>,
    write: () => {},
    failed: () => {},
  });
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await assert.rejects(cleanup.purgeCallLogs({ settleTimeoutMs: 200 }), /did not settle/);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    batch.resetLogWriteBatchForTests();
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM call_logs WHERE id = 'kept-1'"), 1);
  assert.ok(artifactFiles().length >= 1, "its detail file is kept");
});

test("waitForCallLogSaves covers queued rows and their detail files", async () => {
  await callLogs.saveCallLog(callLogEntry("wait-1"));
  assert.equal(batch.getQueuedLogWriteCount(), 1);
  assert.equal(await callLogs.waitForCallLogSaves(5000), true);
  assert.equal(
    count("SELECT COUNT(*) AS n FROM call_logs WHERE id = 'wait-1' AND detail_state = 'ready'"),
    1
  );
});

test("shutdown drains the queue; later rows are written at once", async () => {
  await usageHistory.saveRequestUsage(usageEntry("before-shutdown"));
  await callLogs.closeCallLogSaves(2000);
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'before-shutdown'"), 1);
  assert.equal(batch.isLogBatchingActive(), false);
  await usageHistory.saveRequestUsage(usageEntry("after-shutdown"));
  assert.equal(count("SELECT COUNT(*) AS n FROM usage_history WHERE model = 'after-shutdown'"), 1);
});
