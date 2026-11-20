/**
 * Stage-2 T3 tests for scripts/perf/request-io-probe.ts (node:test).
 *
 * Pure parts only: argument parsing, counter-file classification (pid-based),
 * window delta math (decreases throw), counter-file reading (atomic writes,
 * retries, .tmp skip), self-checks, the SSE content reader, and the M7
 * per-name breakdown, plus the fake upstream answering one stream and one
 * non-stream request in-process. The fake upstream is an in-process HTTP
 * server (real fetch against 127.0.0.1, no repo server boot); the full probe
 * run needs a built dist/ and cannot run here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  BATCH_SETTLE_MS,
  STREAM_CHUNKS,
  checkSelfChecks,
  chunkHasContent,
  classifyCounterFile,
  copyCounterFiles,
  createCleanupRegistry,
  createSseLineReader,
  deltaCounts,
  firstContentChunk,
  groupCounterFiles,
  median,
  otherChildRequestWork,
  parseProbeArgs,
  parseSseDataChunks,
  readCounterFiles,
  redactSecrets,
  serverNameDeltas,
  startFakeUpstream,
  sumCounts,
  serverTotal,
  findPidsByDataDir,
  stopProcessesUsing,
  validateProbeArgs,
  type CounterFile,
} from "../../scripts/perf/request-io-probe.ts";

function counterFile(overrides: Partial<CounterFile> = {}): CounterFile {
  return {
    pid: 100,
    ppid: 90,
    threadId: 0,
    isMainThread: true,
    argv: ["node", "server.js"],
    role: "process",
    counts: {
      sqlite: { statements: 0, prepare: 0, exec: 0, byDriver: {} },
      fsSync: {},
      fsAsync: {},
      fsCallback: {},
      workersCreated: 5,
      driversHooked: [],
      driversUsed: [],
    },
    writtenAt: 1,
    ...overrides,
  };
}

test("M7 snapshots wait the log batch window plus 1 s, and the report records it", () => {
  assert.equal(BATCH_SETTLE_MS, 6_000);
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../scripts/perf/request-io-probe.ts"),
    "utf8"
  );
  // After the warm-up, the plain window and the streamed window; the idle window stays 10 s.
  assert.equal(source.match(/await sleep\(BATCH_SETTLE_MS\);/g)?.length, 3);
  assert.match(source, /await sleep\(10_000\);\n\s+const idleSnapshot/);
  assert.match(source, /settleMs: BATCH_SETTLE_MS,/);
});

test("parseProbeArgs: defaults, io flags and real flags", () => {
  const io = parseProbeArgs(["--root", "/arm", "--out", "report.json"]);
  assert.equal(io.mode, "io");
  assert.equal(io.root, "/arm");
  assert.equal(io.out, "report.json");
  assert.equal(io.portBase, 0);
  assert.equal(io.idleCheckSeconds, 0);
  const real = parseProbeArgs([
    "--mode",
    "real",
    "--root-a",
    "/a",
    "--root-b",
    "/b",
    "--out",
    "m9b.json",
  ]);
  assert.equal(real.mode, "real");
  assert.equal(real.rootA, "/a");
  assert.equal(real.rootB, "/b");
  assert.throws(() => parseProbeArgs(["--mode", "live"]), /--mode must be io or real/);
  assert.throws(() => parseProbeArgs(["--nope"]), /unknown flag/);
  assert.throws(() => parseProbeArgs(["--root"]), /requires a value/);
});

test("validateProbeArgs: io needs --root, real needs --root-a (--root-b optional)", () => {
  validateProbeArgs(parseProbeArgs(["--root", "/arm"]));
  validateProbeArgs(parseProbeArgs(["--mode", "real", "--root-a", "/a", "--root-b", "/b"]));
  validateProbeArgs(parseProbeArgs(["--mode", "real", "--root-a", "/a"]));
  assert.throws(() => validateProbeArgs(parseProbeArgs([])), /--root is required/);
  assert.throws(
    () => validateProbeArgs(parseProbeArgs(["--mode", "real"])),
    /--root-a is required/
  );
  assert.throws(
    () => validateProbeArgs(parseProbeArgs(["--mode", "real", "--root-b", "/b"])),
    /--root-a is required/
  );
});

test("parseProbeArgs: --counters-out is accepted", () => {
  const args = parseProbeArgs(["--root", "/arm", "--counters-out", "/tmp/counters"]);
  assert.equal(args.countersOut, "/tmp/counters");
  assert.equal(parseProbeArgs(["--root", "/arm"]).countersOut, null);
  assert.throws(() => parseProbeArgs(["--root", "/arm", "--counters-out"]), /requires a value/);
});

test("createCleanupRegistry: reverse order, once-only, throwing cleanup does not stop others", async () => {
  const order: string[] = [];
  const registry = createCleanupRegistry();
  registry.register(() => {
    order.push("first");
  });
  registry.register(() => {
    order.push("second");
    throw new Error("boom");
  });
  registry.register(async () => {
    order.push("third");
  });
  await registry.runAll();
  assert.deepEqual(order, ["third", "second", "first"]);
  await registry.runAll();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("createCleanupRegistry: installSignalHandlers is idempotent", () => {
  const registry = createCleanupRegistry();
  const before = process.listenerCount("SIGINT");
  registry.installSignalHandlers();
  registry.installSignalHandlers();
  assert.equal(process.listenerCount("SIGINT"), before + 1);
  process.removeAllListeners("SIGINT");
  // Restore: nothing else in this file installs SIGINT handlers.
});

test("copyCounterFiles: copies only *.json, creates dest, null flag is a no-op", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "reqio-counters-src-"));
  const destParent = fs.mkdtempSync(path.join(os.tmpdir(), "reqio-counters-destparent-"));
  const dest = path.join(destParent, "nested", "out");
  try {
    fs.writeFileSync(path.join(src, "a.json"), '{"x":1}');
    fs.writeFileSync(path.join(src, "b.tmp"), "partial");
    fs.writeFileSync(path.join(src, "notes.txt"), "not a counter");
    copyCounterFiles(src, dest);
    assert.deepEqual(fs.readdirSync(dest).sort(), ["a.json"]);
    assert.equal(fs.readFileSync(path.join(dest, "a.json"), "utf8"), '{"x":1}');
    // Null flag: no-op, must not throw even for a missing counter dir.
    copyCounterFiles(path.join(src, "missing"), null);
    copyCounterFiles(path.join(src, "missing"), path.join(destParent, "other"));
    assert.ok(!fs.existsSync(path.join(destParent, "other", "a.json")));
    // A destination that cannot be created (a regular file is in the way) must not throw:
    // cleanup steps run after this call.
    const blocker = path.join(destParent, "blocker");
    fs.writeFileSync(blocker, "a file, not a dir");
    assert.doesNotThrow(() => copyCounterFiles(src, path.join(blocker, "sub")));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(destParent, { recursive: true, force: true });
  }
});

test("classifyCounterFile: pid-based workers, serve parent, other children", () => {
  assert.equal(
    classifyCounterFile(
      { argv: ["node", "dist/server.js"], threadId: 0, isMainThread: true, pid: 100 },
      new Set([100])
    ),
    "serverMain"
  );
  assert.equal(
    classifyCounterFile(
      { argv: ["node", "server-ws.mjs"], threadId: 0, isMainThread: true, pid: 100 },
      new Set([100])
    ),
    "serverMain"
  );
  // Same pid as the server main + nonzero thread = worker ...
  assert.equal(
    classifyCounterFile(
      { argv: ["node", "dist/server.js"], threadId: 3, isMainThread: false, pid: 100 },
      new Set([100])
    ),
    "workers"
  );
  // ... but argv alone is not enough: an unknown pid is not a worker.
  assert.equal(
    classifyCounterFile(
      { argv: ["node", "dist/server.js"], threadId: 3, isMainThread: false, pid: 777 },
      new Set([100])
    ),
    "otherChildren"
  );
  assert.equal(
    classifyCounterFile({
      argv: ["node", "bin/omniroute.mjs", "serve"],
      threadId: 0,
      isMainThread: true,
      pid: 90,
    }),
    "serveParent"
  );
  assert.equal(
    classifyCounterFile(
      { argv: ["node", "driver-probe.mjs"], threadId: 0, isMainThread: true, pid: 91 },
      new Set([100])
    ),
    "otherChildren"
  );
});

test("groupCounterFiles: needs all files to classify workers by pid", () => {
  // Same argv, different pid: the thread belongs to the pid-100 main only.
  const groups = groupCounterFiles([
    counterFile({ pid: 100, argv: ["node", "dist/server.js"] }),
    counterFile({ pid: 100, argv: ["node", "dist/server.js"], threadId: 2, isMainThread: false }),
    counterFile({ pid: 200, argv: ["node", "dist/server.js"], threadId: 2, isMainThread: false }),
    counterFile({ pid: 90, argv: ["node", "bin/omniroute.mjs", "serve"] }),
    counterFile({ pid: 300, argv: ["node", "other.mjs"] }),
  ]);
  assert.equal(groups.serverMain.length, 1);
  assert.equal(groups.workers.length, 1);
  assert.equal(groups.serveParent.length, 1);
  assert.equal(groups.otherChildren.length, 2);
  assert.deepEqual(
    groups.workers.map((file) => file.pid),
    [100]
  );
});

test("sumCounts and deltaCounts: whole counts, decreases throw", () => {
  const file = counterFile({
    counts: {
      sqlite: {
        statements: 4,
        prepare: 2,
        exec: 1,
        byDriver: { "better-sqlite3": { statements: 4, prepare: 2, exec: 1 } },
      },
      fsSync: { readFileSync: 3 },
      fsAsync: { readFile: 2 },
      fsCallback: { stat: 1 },
      workersCreated: 5,
      driversHooked: ["better-sqlite3"],
      driversUsed: ["better-sqlite3"],
    },
  });
  const total = sumCounts([file, file]);
  assert.deepEqual(total, {
    sqliteStatements: 8,
    sqlitePrepare: 4,
    sqliteExec: 2,
    fsSync: 6,
    fsAsync: 4,
    fsCallback: 2,
  });
  const before = sumCounts([file]);
  assert.deepEqual(deltaCounts(before, total), before);
  // Counters never decrease: a smaller "after" snapshot throws, naming the counter.
  assert.throws(() => deltaCounts(total, before), /sqliteStatements/);
  assert.throws(
    () =>
      deltaCounts(
        {
          sqliteStatements: 0,
          sqlitePrepare: 0,
          sqliteExec: 0,
          fsSync: 2,
          fsAsync: 0,
          fsCallback: 0,
        },
        {
          sqliteStatements: 0,
          sqlitePrepare: 0,
          sqliteExec: 0,
          fsSync: 1,
          fsAsync: 0,
          fsCallback: 0,
        }
      ),
    /fsSync/
  );
});

test("readCounterFiles: ignores .tmp, throws on a bad file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reqio-probe-test-"));
  try {
    fs.writeFileSync(path.join(dir, "1-0.json"), JSON.stringify(counterFile({ pid: 1 })));
    fs.writeFileSync(path.join(dir, "1-1.tmp"), "partial");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a counter");
    const files = readCounterFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.pid, 1);

    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    assert.throws(() => readCounterFiles(dir), /bad\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(readCounterFiles(path.join(dir, "missing")), []);
});

test("otherChildRequestWork: flags request work outside the idle window", () => {
  const request = {
    sqliteStatements: 3,
    sqlitePrepare: 0,
    sqliteExec: 0,
    fsSync: 0,
    fsAsync: 0,
    fsCallback: 0,
  };
  const idle = {
    sqliteStatements: 0,
    sqlitePrepare: 0,
    sqliteExec: 0,
    fsSync: 0,
    fsAsync: 0,
    fsCallback: 0,
  };
  assert.equal(otherChildRequestWork(request, idle), true);
  assert.equal(otherChildRequestWork(idle, idle), false);
  assert.equal(otherChildRequestWork(request, request), false);
});

test("checkSelfChecks: fails on missing main, zero sqlite, no driver, unreported worker", () => {
  const withCounts = (counts: Partial<CounterFile["counts"]>): CounterFile =>
    counterFile({ counts: { ...counterFile().counts, ...counts } });
  const main = withCounts({
    sqlite: {
      statements: 4,
      prepare: 2,
      exec: 1,
      byDriver: { "better-sqlite3": { statements: 4, prepare: 2, exec: 1 } },
    },
    driversHooked: ["better-sqlite3"],
    driversUsed: ["better-sqlite3"],
  });
  const ok = checkSelfChecks({ serverMain: [main], workers: [], mainWorkersCreated: 0 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.failures, []);

  const missing = checkSelfChecks({ serverMain: [], workers: [], mainWorkersCreated: 0 });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join("; "), /no server main counter file/);

  // Hooks counted nothing: sqlite total is 0 across main + workers.
  const quiet = checkSelfChecks({
    serverMain: [counterFile({ counts: { ...counterFile().counts, driversHooked: ["x"] } })],
    workers: [],
    mainWorkersCreated: 0,
  });
  assert.equal(quiet.ok, false);
  assert.match(quiet.failures.join("; "), /sqlite total.*is 0/);

  // No driver used on main + workers: hooked-at-load proves nothing, so the
  // self-check fails when driversUsed is empty even with sqlite counts > 0.
  const unused = checkSelfChecks({
    serverMain: [
      withCounts({
        sqlite: { statements: 1, prepare: 0, exec: 0, byDriver: {} },
        driversHooked: ["node:sqlite"],
        driversUsed: [],
      }),
    ],
    workers: [],
    mainWorkersCreated: 0,
  });
  assert.equal(unused.ok, false);
  assert.match(unused.failures.join("; "), /no sqlite driver used/);

  // Passes when driversUsed holds better-sqlite3 on main or a worker.
  const workerUsed = checkSelfChecks({
    serverMain: [
      withCounts({
        sqlite: { statements: 0, prepare: 0, exec: 0, byDriver: {} },
        driversHooked: ["node:sqlite"],
        driversUsed: [],
      }),
    ],
    workers: [
      counterFile({
        counts: {
          ...counterFile().counts,
          sqlite: {
            statements: 1,
            prepare: 0,
            exec: 0,
            byDriver: { "better-sqlite3": { statements: 1, prepare: 0, exec: 0 } },
          },
          driversHooked: ["better-sqlite3"],
          driversUsed: ["better-sqlite3"],
        },
      }),
    ],
    mainWorkersCreated: 0,
  });
  assert.equal(workerUsed.ok, true);

  // A created worker never reported: workersCreated > worker files seen.
  const unreported = checkSelfChecks({
    serverMain: [main],
    workers: [counterFile()],
    mainWorkersCreated: 2,
  });
  assert.equal(unreported.ok, false);
  assert.match(unreported.failures.join("; "), /workersCreated/);
});

test("chunkHasContent: reasoning tokens count as the first token", () => {
  const reasoning = JSON.stringify({ choices: [{ delta: { reasoning: "thinking" } }] });
  const reasoningContent = JSON.stringify({ choices: [{ delta: { reasoning_content: "hm" } }] });
  assert.equal(chunkHasContent(reasoning), true);
  assert.equal(chunkHasContent(reasoningContent), true);
  assert.equal(
    chunkHasContent(JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning: "" } }] })),
    false
  );
});

test("chunkHasContent: only non-empty chat content counts", () => {
  const content = JSON.stringify({
    choices: [{ delta: { content: "ok" } }],
  });
  assert.equal(chunkHasContent(content), true);
  assert.equal(chunkHasContent("[DONE]"), false);
  assert.equal(chunkHasContent(""), false);
  assert.equal(chunkHasContent("not json"), false);
  assert.equal(
    chunkHasContent(
      JSON.stringify({
        choices: [{ delta: { role: "assistant" } }],
      })
    ),
    false
  );
  assert.equal(
    chunkHasContent(
      JSON.stringify({
        choices: [{ delta: { content: "" } }],
      })
    ),
    false
  );
  assert.equal(chunkHasContent(JSON.stringify({ choices: [] })), false);
});

test("SSE parser: first content chunk and chunk list", () => {
  const content = (text: string): string =>
    JSON.stringify({ choices: [{ delta: { content: text } }] });
  const roleOnly = JSON.stringify({ choices: [{ delta: { role: "assistant" } }] });
  assert.equal(
    firstContentChunk([
      { atMs: 1, data: roleOnly },
      { atMs: 2, data: content("hello") },
      { atMs: 3, data: "[DONE]" },
    ]),
    2
  );
  assert.equal(firstContentChunk([{ atMs: 1, data: "[DONE]" }]), null);
  assert.equal(firstContentChunk([{ atMs: 1, data: roleOnly }]), null);
  assert.equal(firstContentChunk([]), null);
  assert.deepEqual(parseSseDataChunks('data: {"a":1}\n\ndata: [DONE]\n\n'), ['{"a":1}', "[DONE]"]);
  assert.deepEqual(parseSseDataChunks(""), []);
});

test("createSseLineReader: buffers partial lines across feeds", () => {
  const reader = createSseLineReader();
  const content = JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
  const wire = `data: ${content}\n\ndata: [DONE]\n\n`;
  const first = wire.slice(0, 10);
  const second = wire.slice(10, 25);
  const rest = wire.slice(25);
  assert.deepEqual(reader.feed(first), []);
  // Split mid-line: the first payload is incomplete, so nothing is emitted yet.
  assert.deepEqual(reader.feed(second), []);
  // The remainder completes both lines at once.
  assert.deepEqual(reader.feed(rest), [content, "[DONE]"]);
  // A trailing partial line is held until terminated, then flushed.
  assert.deepEqual(reader.feed("data: part"), []);
  assert.deepEqual(reader.feed("ial\n\n"), ["partial"]);
  assert.deepEqual(reader.flush(), []);
});

test("serverNameDeltas: per-name server breakdown, sorted, top 20, zero omitted", () => {
  const before = counterFile({
    pid: 100,
    counts: {
      ...counterFile().counts,
      fsSync: { readFileSync: 2, statSync: 5, gone: 3 },
      fsAsync: { readFile: 1 },
      fsCallback: {},
      sqlite: {
        statements: 0,
        prepare: 0,
        exec: 0,
        byDriver: { "a-driver": { statements: 1, prepare: 1, exec: 1 } },
      },
    },
  });
  const after = counterFile({
    pid: 100,
    counts: {
      ...counterFile().counts,
      fsSync: { readFileSync: 10, statSync: 6, gone: 3 },
      fsAsync: { readFile: 4 },
      fsCallback: { stat: 2 },
      sqlite: {
        statements: 0,
        prepare: 0,
        exec: 0,
        byDriver: {
          "a-driver": { statements: 2, prepare: 2, exec: 2 },
          "b-driver": { statements: 1, prepare: 0, exec: 0 },
        },
      },
    },
  });
  const breakdown = serverNameDeltas([before], [after]);
  assert.deepEqual(breakdown.fsSync, [
    { name: "readFileSync", delta: 8 },
    { name: "statSync", delta: 1 },
  ]);
  assert.deepEqual(breakdown.fsAsync, [{ name: "readFile", delta: 3 }]);
  assert.deepEqual(breakdown.fsCallback, [{ name: "stat", delta: 2 }]);
  assert.deepEqual(breakdown.sqlite, [
    { name: "a-driver", delta: 3 },
    { name: "b-driver", delta: 1 },
  ]);

  // Top 20 cap: 25 growing names keep the 20 largest deltas.
  const manyBefore = counterFile({ pid: 100 });
  const fsSyncAfter: Record<string, number> = {};
  for (let i = 0; i < 25; i++) fsSyncAfter[`fn${i}`] = i + 1;
  const manyAfter = counterFile({
    pid: 100,
    counts: { ...counterFile().counts, fsSync: fsSyncAfter },
  });
  const capped = serverNameDeltas([manyBefore], [manyAfter]);
  assert.equal(capped.fsSync.length, 20);
  assert.equal(capped.fsSync[0]?.delta, 25);
  assert.equal(capped.fsSync[19]?.delta, 6);

  // A decreased name throws.
  assert.throws(() => serverNameDeltas([after], [before]), /counter decreased/);
});

test("median helper for M8/M9a", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1]), 2.5);
  assert.throws(() => median([]), /empty sample set/);
});

test("redactSecrets: long tokens and bearer material never reach reports", () => {
  const scrubbed = redactSecrets(
    "failed with Bearer abcdefghijklmnopqrstuvwxyz and apiKey: supersecretvalue123"
  );
  assert.doesNotMatch(scrubbed, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(scrubbed, /supersecretvalue123/);
});

test("fake upstream answers one non-stream and one stream request in-process", async () => {
  const upstream = await startFakeUpstream(0);
  try {
    const plain = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "perfio/test-model",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(plain.status, 200);
    const json = (await plain.json()) as { object: string };
    assert.equal(json.object, "chat.completion");

    const streamed = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "perfio/test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(streamed.status, 200);
    const text = await streamed.text();
    const chunks = parseSseDataChunks(text);
    assert.equal(chunks[chunks.length - 1], "[DONE]");
    const content = chunks.filter((chunk) => chunk !== "[DONE]");
    assert.equal(content.length, STREAM_CHUNKS);
    assert.ok(content.every((chunk) => chunk.includes("chat.completion.chunk")));
  } finally {
    await upstream.stop();
  }
});

test("findPidsByDataDir matches DATA_DIR exactly in /proc/<pid>/environ", () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "probe-fakeproc-"));
  try {
    const put = (pid: string, env: string[]) => {
      fs.mkdirSync(path.join(proc, pid));
      fs.writeFileSync(path.join(proc, pid, "environ"), env.join("\0") + "\0");
    };
    put("101", ["PATH=/bin", "DATA_DIR=/tmp/run-a"]);
    put("102", ["DATA_DIR=/tmp/run-a-other"]); // prefix only: must not match
    put("103", ["DATA_DIR=/tmp/run-b", "X=1"]);
    put("104", ["HOME=/root"]);
    fs.mkdirSync(path.join(proc, "105")); // no environ (unreadable): skipped
    fs.mkdirSync(path.join(proc, "self"));
    put(String(process.pid), ["DATA_DIR=/tmp/run-a"]); // never this process
    assert.deepEqual(
      findPidsByDataDir(["/tmp/run-a", "/tmp/run-b"], proc).sort((a, b) => a - b),
      [101, 103]
    );
    assert.deepEqual(findPidsByDataDir(["/tmp/none"], proc), []);
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }
});

test("stopProcessesUsing stops a detached process found only by its DATA_DIR", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-stop-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, DATA_DIR: dataDir },
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !findPidsByDataDir([dataDir]).includes(child.pid as number)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const stopped = await stopProcessesUsing([dataDir], 5_000);
    assert.ok(stopped.includes(child.pid as number), "the child was found by DATA_DIR");
    await exited;
    assert.deepEqual(findPidsByDataDir([dataDir]), []);
  } finally {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      /* already gone */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("serverTotal sums every counter of server main + workers (M7 scope)", () => {
  const delta = (n: number) => ({
    sqliteStatements: n,
    sqlitePrepare: n + 1,
    sqliteExec: n + 2,
    fsSync: n + 3,
    fsAsync: n + 4,
    fsCallback: n + 5,
  });
  const total = serverTotal({
    serverMain: delta(10),
    workers: delta(100),
    serveParent: delta(1000),
    otherChildren: delta(5000),
  });
  assert.deepEqual(total, {
    sqliteStatements: 110,
    sqlitePrepare: 112,
    sqliteExec: 114,
    fsSync: 116,
    fsAsync: 118,
    fsCallback: 120,
  });
});
