/**
 * Stage-2 T4 tests for scripts/perf/time-build.mjs (node:test).
 *
 * The spawn target is injectable, so every case runs a fake command — never a
 * real build. Cases: arg parsing, an exiting-0 fake (status ok), an exiting-1
 * fake (status failed), and a sleeping fake with a tiny timeout (status
 * timeout). The tail keeps only the last 2000 chars of combined output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { BUILD_ARGS, BUILD_COMMAND, parseArgs, runTimedBuild } =
  await import("../../scripts/perf/time-build.mjs");

function fakeChild({ exitCode = 0, signal = null, closeDelayMs = 5 } = {}) {
  const child = new EventEmitter();
  child.pid = 100000 + Math.floor(Math.random() * 10000);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    child.emit("close", exitCode, signal);
  }, closeDelayMs).unref();
  return child;
}

test("parseArgs: --root and --out are required", () => {
  const options = parseArgs(["--root", "/arm", "--out", "report.json"]);
  assert.equal(options.root, "/arm");
  assert.equal(options.out, "report.json");
  assert.throws(() => parseArgs(["--root", "/arm"]), /--out/);
  assert.throws(() => parseArgs(["--out", "r.json"]), /--root/);
  assert.throws(() => parseArgs(["--bogus", "x"]), /unknown flag/);
  assert.throws(() => parseArgs(["--root"]), /needs a value/);
});

test("exiting-0 fake reports ok with exit code 0", async () => {
  let seen;
  const spawnImpl = (command, args, options) => {
    seen = { command, args, options };
    return fakeChild({ exitCode: 0 });
  };
  const result = await runTimedBuild({ cwd: "/arm", env: {}, spawnImpl, timeoutMs: 10_000 });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(seen.command, BUILD_COMMAND);
  assert.deepEqual(seen.args, [...BUILD_ARGS]);
  assert.equal(seen.options.cwd, "/arm");
  assert.equal(seen.options.detached, true);
  assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
  assert.ok(typeof result.startedAt === "string");
  assert.ok(typeof result.tail === "string");
});

test("exiting-1 fake reports failed with exit code 1", async () => {
  const spawnImpl = () => fakeChild({ exitCode: 1 });
  const result = await runTimedBuild({ cwd: "/arm", env: {}, spawnImpl, timeoutMs: 10_000 });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
});

test("sleeping fake with a tiny timeout reports timeout", async () => {
  const spawnImpl = (command, args) =>
    fakeChild({ closeDelayMs: 60_000, extra: [command, args].length });
  const result = await runTimedBuild({
    cwd: "/arm",
    env: {},
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},200)"],
    timeoutMs: 50,
    killGraceMs: 10,
    spawnImpl,
    now: () => Date.now(),
  });
  assert.equal(result.status, "timeout");
});

test("node sleeper with a tiny timeout reports timeout through the real spawn", async () => {
  const { spawn } = await import("node:child_process");
  const result = await runTimedBuild({
    cwd: process.cwd(),
    env: process.env,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},30000)"],
    timeoutMs: 100,
    killGraceMs: 50,
    spawnImpl: spawn,
  });
  assert.equal(result.status, "timeout");
});

test("tail keeps the last 2000 chars of combined output", async () => {
  const big = "x".repeat(1500);
  const spawnImpl = () => {
    const child = fakeChild({ exitCode: 0 });
    setTimeout(() => {
      child.stdout.emit("data", `${big}-OUT`);
      child.stderr.emit("data", `${big}-ERR`);
    }, 1).unref();
    return child;
  };
  const result = await runTimedBuild({ cwd: "/arm", env: {}, spawnImpl, timeoutMs: 10_000 });
  assert.equal(result.status, "ok");
  assert.equal(result.tail.length, 2000);
  assert.ok(result.tail.endsWith(`${big}-ERR`));
});

test("spawn throw reports failed without throwing", async () => {
  const spawnImpl = () => {
    throw new Error("spawn ENOENT");
  };
  const result = await runTimedBuild({ cwd: "/arm", env: {}, spawnImpl, timeoutMs: 10_000 });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, null);
  assert.match(result.tail, /could not start/);
});
