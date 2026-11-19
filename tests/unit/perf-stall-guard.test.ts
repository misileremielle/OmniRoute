import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GUARD = path.resolve("scripts/perf/stall-guard.sh");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run stall-guard with stdout/stderr to `log`, as the suite body does. Resolves rc + ms. */
function runGuard(
  stallS: number,
  script: string,
  dir: string,
  onSpawn?: (pid: number) => void,
  pollS: string | null = "0.2",
  extraEnv: Record<string, string> = {}
): Promise<{ rc: number | null; signal: NodeJS.Signals | null; ms: number; log: string }> {
  const log = path.join(dir, "part.log");
  const fd = fs.openSync(log, "w");
  const started = Date.now();
  const child = spawn("bash", [GUARD, String(stallS), log, "--", "bash", "-c", script], {
    stdio: ["ignore", fd, fd],
    env:
      pollS === null
        ? { ...process.env, ...extraEnv }
        : { ...process.env, STALL_POLL_S: pollS, ...extraEnv },
  });
  fs.closeSync(fd);
  if (onSpawn && child.pid) onSpawn(child.pid);
  return new Promise((resolve) => {
    child.once("exit", (rc, signal) =>
      resolve({ rc, signal, ms: Date.now() - started, log: fs.readFileSync(log, "utf8") })
    );
  });
}

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-stall-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("stall-guard passes the command's exit status through (including timeout's 124)", async (t) => {
  const dir = tmp(t);
  assert.equal((await runGuard(5, "echo hi; exit 3", dir)).rc, 3);
  assert.equal((await runGuard(5, "echo hi", dir)).rc, 0);
  assert.equal((await runGuard(5, "timeout 0.3s sleep 5", dir)).rc, 124);
});

test("stall-guard adds no time: a short command returns at once under the default 15 s poll", async (t) => {
  const dir = tmp(t);
  const r = await runGuard(600, "echo quick", dir, undefined, null);
  assert.equal(r.rc, 0);
  assert.ok(r.ms < 2_000, `took ${r.ms} ms`);
});

test("stall-guard kills a silent command's whole group (grandchildren too) and exits 75", async (t) => {
  const dir = tmp(t);
  const pidFile = path.join(dir, "grandchild.pid");
  // A grandchild that blocks without output, like the hung test file under the node runner.
  const r = await runGuard(1, `echo start; sleep 300 & echo $! > ${pidFile}; wait`, dir);
  assert.equal(r.rc, 75);
  assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  assert.match(r.log, /stall-guard: .* did not grow for \d+s; killing group/);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(alive(grandchild), false, "the blocked grandchild is gone");
});

test("stall-guard leaves a command alone while its log keeps growing", async (t) => {
  const dir = tmp(t);
  // 3 s of output every 0.3 s with a 1 s stall limit: never silent for 1 s.
  const r = await runGuard(1, "for i in $(seq 10); do echo tick $i; sleep 0.3; done; exit 0", dir);
  assert.equal(r.rc, 0);
  assert.match(r.log, /tick 10/);
  assert.doesNotMatch(r.log, /did not grow/);
  // The margin is recorded: the longest quiet gap, under the limit.
  assert.match(r.log, /stall-guard: longest quiet gap \d+s \(limit 1s\)/);
});

test("stall-guard forwards SIGTERM to the whole group", async (t) => {
  const dir = tmp(t);
  const pidFile = path.join(dir, "grandchild.pid");
  let guardPid = 0;
  const run = runGuard(
    60,
    `sleep 300 & echo $! > ${pidFile}; while :; do echo .; sleep 0.1; done`,
    dir,
    (pid) => (guardPid = pid)
  );
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(guardPid, "SIGTERM");
  const r = await run;
  assert.equal(r.rc, 143, "a forwarded TERM ends the guard with 128 + 15");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 20 && alive(grandchild); i++)
    await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(grandchild), false, "TERM reached the grandchild");
});

/** Start a guard, wait until `ready` exists, send it SIGTERM, return the result. */
async function termGuard(
  dir: string,
  script: string,
  ready: string,
  env: Record<string, string> = {}
) {
  let guardPid = 0;
  const run = runGuard(60, script, dir, (pid) => (guardPid = pid), "0.2", env);
  for (let i = 0; i < 50 && !fs.existsSync(ready); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  process.kill(guardPid, "SIGTERM");
  return run;
}

test("stall-guard: a command that exits 1 on TERM (the node runner) still ends as 143", async (t) => {
  const dir = tmp(t);
  const ready = path.join(dir, "ready");
  const r = await termGuard(
    dir,
    `trap 'exit 1' TERM; touch ${ready}; while :; do echo .; sleep 0.1; done`,
    ready
  );
  assert.equal(r.rc, 143);
});

test("stall-guard: a group that ignores TERM is SIGKILLed after STALL_KILL_AFTER_S", async (t) => {
  const dir = tmp(t);
  const ready = path.join(dir, "ready");
  const r = await termGuard(
    dir,
    `trap '' TERM; touch ${ready}; while :; do echo .; sleep 0.1; done`,
    ready,
    { STALL_KILL_AFTER_S: "1" }
  );
  assert.equal(r.rc, 143);
  assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  assert.match(r.log, /still running 1s after a forwarded signal; SIGKILL/);
});

test("stall-guard: after a forwarded TERM, a group member that ignores it dies even when the command exits", async (t) => {
  // The case the runbook stop is for: the runner exits 1 on TERM, a hung test child stays.
  const dir = tmp(t);
  const ready = path.join(dir, "ready");
  const childPid = path.join(dir, "child.pid");
  const r = await termGuard(
    dir,
    `(trap '' TERM; while :; do sleep 0.1; done) & echo $! > ${childPid}; ` +
      `trap 'exit 1' TERM; touch ${ready}; while :; do echo .; sleep 0.1; done`,
    ready,
    { STALL_KILL_AFTER_S: "1" }
  );
  assert.equal(r.rc, 143);
  assert.match(r.log, /processes left in group \d+ after the command ended; SIGKILL/);
  assert.equal(
    alive(Number(fs.readFileSync(childPid, "utf8"))),
    false,
    "the TERM-ignoring child is gone"
  );
});

test("stall-guard: a process left after a normal end is killed after 5 s, status kept", async (t) => {
  const dir = tmp(t);
  const childPid = path.join(dir, "child.pid");
  const r = await runGuard(60, `sleep 300 & echo $! > ${childPid}; echo done; exit 1`, dir);
  assert.equal(r.rc, 1);
  assert.ok(r.ms >= 4_500 && r.ms < 15_000, `took ${r.ms} ms`);
  assert.match(r.log, /processes left in group \d+ after the command ended; SIGKILL/);
  assert.match(r.log, /stall-guard: group empty \d+ ms after the command ended/);
  assert.equal(alive(Number(fs.readFileSync(childPid, "utf8"))), false, "the leftover is gone");
});

test("stall-guard: with the default kill-after, a TERM-ignoring group is gone well before the driver's 30 s", async (t) => {
  // The reap (default 15 s, then 1 s polls) stays below the outer `timeout --kill-after=30s`,
  // so it is done even if that timeout is still alive to SIGKILL its group.
  const dir = tmp(t);
  const ready = path.join(dir, "ready");
  // Production poll (15 s): after the signal the guard must switch to 1 s polls.
  const r = await termGuard(
    dir,
    `trap '' TERM; touch ${ready}; while :; do echo .; sleep 0.1; done`,
    ready,
    { STALL_POLL_S: "15" }
  );
  assert.equal(r.rc, 143);
  assert.match(r.log, /still running 15s after a forwarded signal; SIGKILL/);
  assert.ok(r.ms < 25_000, `guard took ${r.ms} ms from start`);
});

test("stall-guard refuses bad usage", async (t) => {
  const dir = tmp(t);
  const log = path.join(dir, "x.log");
  const rc = (args: string[]) =>
    new Promise<number | null>((resolve) =>
      spawn("bash", [GUARD, ...args], { stdio: "ignore" }).once("exit", resolve)
    );
  assert.equal(await rc(["0", log, "--", "true"]), 2);
  assert.equal(await rc(["5", log, "true"]), 2);
  assert.equal(await rc(["5", log, "--"]), 2);
  const withEnv = (env: Record<string, string>) =>
    new Promise<number | null>((resolve) =>
      spawn("bash", [GUARD, "5", log, "--", "true"], {
        stdio: "ignore",
        env: { ...process.env, ...env },
      }).once("exit", resolve)
    );
  assert.equal(await withEnv({ STALL_POLL_S: "0" }), 2);
  assert.equal(await withEnv({ STALL_POLL_S: "abc" }), 2);
  assert.equal(await withEnv({ STALL_KILL_AFTER_S: "0" }), 2);
  assert.equal(await withEnv({ STALL_POLL_S: "0.5" }), 0);
});
