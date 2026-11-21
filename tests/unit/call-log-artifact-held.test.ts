// Step-11 fix 3: with log batching, a call log's detail file is serialized when the row is
// queued and held in the artifact worker until the row commits. These tests cover the held
// path of the artifact writer: write after commit, id collision, release, worker crash, the
// serialize cap, and one shared writer across module copies.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-held-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const copyA = await import("../../src/lib/usage/callLogArtifactWriter.ts?copy=route-bundle");
const copyB =
  await import("../../src/lib/usage/callLogArtifactWriter.ts?copy=instrumentation-bundle");
const artifacts = await import("../../src/lib/usage/callLogArtifacts.ts");

type WriterState = { worker: Worker | null; held: Map<number, unknown> };
const writerState = () =>
  (globalThis as unknown as Record<symbol, WriterState>)[
    Symbol.for("omniroute.callLogArtifactWriter")
  ];

test.after(async () => {
  await copyA.closeCallLogArtifactWriter();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function buildArtifact(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5 as const,
    summary: {
      id,
      timestamp: "2026-11-20T01:02:03.456Z",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "m",
      requestedModel: null,
      provider: "p",
      account: "a",
      connectionId: null,
      duration: 1,
      tokens: {
        in: 1,
        out: 1,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai",
      targetFormat: "openai",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { held: true, ...extra },
    responseBody: { content: "ok" },
    error: null,
  };
}

const logsPath = (relPath: string) => path.join(TEST_DATA_DIR, "call_logs", relPath);

test("one writer is shared by every module copy", () => {
  assert.notEqual(copyA, copyB, "the two imports must be separate module copies");
  const key = copyA.holdCallArtifact(buildArtifact("shared-1"));
  assert.equal(typeof key, "number");
  assert.equal(copyB.getHeldCallArtifactCount(), copyA.getHeldCallArtifactCount());
  assert.ok(copyB.getHeldCallArtifactBytes() > 0);
});

test("a detail held through one copy is written through another, then stops counting", async () => {
  const artifact = buildArtifact("held-write-1");
  const key = copyA.holdCallArtifact(artifact)!;
  const [result] = await copyB.writeHeldCallArtifacts([{ key }]);
  assert.ok(result, "the held string is written");
  assert.equal(
    result.relPath,
    artifacts.buildArtifactRelativePath(artifact.summary.timestamp, "held-write-1")
  );
  const serialized = fs.readFileSync(logsPath(result.relPath), "utf8");
  assert.deepEqual(JSON.parse(serialized), artifact);
  assert.equal(result.sizeBytes, Buffer.byteLength(serialized));
  // Drain what the first test left, then nothing is held.
  await copyA.writeHeldCallArtifacts(
    [...writerState().held.keys()].map((k) => ({ key: Number(k) }))
  );
  assert.equal(copyA.getHeldCallArtifactCount(), 0);
  assert.equal(copyA.getHeldCallArtifactBytes(), 0);
});

test("after an id collision the file is written under the new id only (#14451)", async () => {
  const artifact = buildArtifact("dupe-id");
  const key = copyA.holdCallArtifact(artifact)!;
  const [result] = await copyA.writeHeldCallArtifacts([{ key, rowId: "fresh-uuid-1" }]);
  assert.ok(result);
  const oldPath = artifacts.buildArtifactRelativePath(artifact.summary.timestamp, "dupe-id");
  assert.equal(
    result.relPath,
    artifacts.buildArtifactRelativePath(artifact.summary.timestamp, "fresh-uuid-1")
  );
  assert.equal(fs.existsSync(logsPath(oldPath)), false, "nothing is written at the old path");
  const written = JSON.parse(fs.readFileSync(logsPath(result.relPath), "utf8"));
  assert.equal(written.summary.id, "fresh-uuid-1");
  assert.deepEqual(written.requestBody, artifact.requestBody);
});

test("reserializeArtifactWithId patches every form that has a summary", () => {
  const full = JSON.stringify(buildArtifact("old"));
  assert.equal(JSON.parse(artifacts.reserializeArtifactWithId(full, "new")).summary.id, "new");

  const minimal = JSON.stringify({
    schemaVersion: 5,
    summary: buildArtifact("old").summary,
    requestBody: "omitted",
    responseBody: "omitted",
    error: null,
    pipeline: { error: { _omniroute_truncated: true, reason: "size" } },
  });
  const patchedMinimal = JSON.parse(artifacts.reserializeArtifactWithId(minimal, "new"));
  assert.equal(patchedMinimal.summary.id, "new");
  assert.equal(patchedMinimal.requestBody, "omitted");

  const lastResort = JSON.stringify({ schemaVersion: 5, _omniroute_truncated: true, reason: "x" });
  assert.equal(artifacts.reserializeArtifactWithId(lastResort, "new"), lastResort);
});

test("a held entry keeps the settings it was serialized with, even if they change before the write", async () => {
  const previousDebug = process.env.CHAT_DEBUG_FILE;
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-held-other-"));
  try {
    process.env.CHAT_DEBUG_FILE = "true";
    const artifact = buildArtifact("env-1");
    const key = copyA.holdCallArtifact(artifact)!;
    // Both change after the row was queued; a second row is serialized under the new ones, so
    // the worker's current environment no longer matches the first row's.
    delete process.env.CHAT_DEBUG_FILE;
    process.env.DATA_DIR = otherDir;
    const second = copyA.holdCallArtifact(buildArtifact("env-2"))!;
    const [result, secondResult] = await copyA.writeHeldCallArtifacts([
      { key, rowId: "env-1-new" },
      { key: second },
    ]);
    assert.ok(result);
    assert.ok(secondResult);
    const secondFile = fs.readFileSync(
      path.join(otherDir, "call_logs", secondResult.relPath),
      "utf8"
    );
    assert.doesNotMatch(secondFile, /\n {2}"summary"/, "the second row uses its own settings");
    assert.equal(
      fs.existsSync(path.join(otherDir, "call_logs", result.relPath)),
      false,
      "not redirected to the new data dir"
    );
    const serialized = fs.readFileSync(logsPath(result.relPath), "utf8");
    assert.match(serialized, /\n {2}"summary"/, "the debug formatting survives the id patch");
    assert.equal(JSON.parse(serialized).summary.id, "env-1-new");
  } finally {
    process.env.DATA_DIR = TEST_DATA_DIR;
    if (previousDebug === undefined) delete process.env.CHAT_DEBUG_FILE;
    else process.env.CHAT_DEBUG_FILE = previousDebug;
    fs.rmSync(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a released string keeps counting until the worker's reply", async () => {
  const key = copyA.holdCallArtifact(buildArtifact("released-1"))!;
  const before = copyA.getHeldCallArtifactCount();
  copyA.releaseHeldCallArtifacts([key]);
  assert.equal(copyA.getHeldCallArtifactCount(), before, "still counted while the job is queued");
  // A later job runs after the release (one job at a time, first in first out).
  await copyA.writeHeldCallArtifacts([{ key: copyA.holdCallArtifact(buildArtifact("after"))! }]);
  assert.equal(copyA.getHeldCallArtifactCount(), 0);
  assert.equal(copyA.getHeldCallArtifactBytes(), 0);
});

test("a worker crash while holding strings ends those rows missing and frees the count", async () => {
  const keys = [copyA.holdCallArtifact(buildArtifact("crash-1"))!];
  keys.push(copyA.holdCallArtifact(buildArtifact("crash-2"))!);
  // Let both serialize jobs finish, so the worker really holds the strings.
  const probe = copyA.holdCallArtifact(buildArtifact("crash-probe"))!;
  await copyA.writeHeldCallArtifacts([{ key: probe }]);
  assert.equal(copyA.getHeldCallArtifactCount(), 2);

  const worker = writerState().worker;
  assert.ok(worker);
  await worker.terminate(); // exit code 1, as a crash
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(copyA.getHeldCallArtifactCount(), 0, "the dead worker's strings stop counting");
  assert.equal(copyA.getHeldCallArtifactBytes(), 0);

  const results = await copyA.writeHeldCallArtifacts(keys.map((key) => ({ key })));
  assert.deepEqual(results, [null, null], "their rows end missing");
  // The writer recovers with a fresh worker.
  const [next] = await copyA.writeHeldCallArtifacts([
    { key: copyA.holdCallArtifact(buildArtifact("after-crash"))! },
  ]);
  assert.ok(next);
});

test("a fresh worker answers unknown keys with null per key, not a failed job", async () => {
  const worker = new Worker(pathToFileURL(path.resolve("src/lib/usage/callLogArtifactWorker.ts")), {
    execArgv: [],
  });
  try {
    const reply = await new Promise<{ id: number; results: unknown[] }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage({
        kind: "write",
        id: 7,
        entries: [{ key: 101 }, { key: 102, rowId: "x" }],
      });
    });
    assert.deepEqual(reply, { id: 7, results: [null, null] });
  } finally {
    await worker.terminate();
  }
});

test("write jobs bypass the serialize cap, so committed rows are never stranded", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const keys: number[] = [];
    // One active job plus 128 queued serialize jobs fills the cap.
    for (let i = 0; i < 129; i++) {
      const key = copyA.holdCallArtifact(buildArtifact(`cap-${i}`));
      assert.equal(typeof key, "number", `row ${i} is accepted`);
      keys.push(key!);
    }
    assert.equal(copyA.holdCallArtifact(buildArtifact("cap-over")), null, "the next is refused");
    const results = await copyA.writeHeldCallArtifacts(keys.map((key) => ({ key })));
    assert.equal(results.filter(Boolean).length, 129, "every accepted row is written");
    assert.equal(copyA.getHeldCallArtifactCount(), 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("once closing, a write is refused and its entries are released", async () => {
  const key = copyA.holdCallArtifact(buildArtifact("closing-1"))!;
  await copyA.closeCallLogArtifactWriter();
  const results = await copyA.writeHeldCallArtifacts([{ key }]);
  assert.deepEqual(results, [null]);
  assert.equal(copyA.getHeldCallArtifactCount(), 0);
  assert.equal(copyA.getHeldCallArtifactBytes(), 0);
});
