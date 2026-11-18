// Addendum A1: scripts/perf/m10-sweep.mjs, the driver's after-failure sweep. It must run with
// plain node (no node_modules on the vm's driver checkout), and delete only an owned folder
// that no process uses any more.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OWNER_MARKER, ownedBy, sweep } from "../../scripts/perf/m10-sweep.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_SRC = path.resolve(here, "..", "..", "scripts", "perf", "m10-sweep.mjs");

function ownedDir(t: { after: (fn: () => void) => void }, token: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "perf-m10-sweep-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const d = path.join(parent, "probe-r1-m10-a1");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, OWNER_MARKER), JSON.stringify({ token }));
  return d;
}

test("m10-sweep: absent, not-owner and still-used leave the folder; swept deletes it", async (t) => {
  assert.deepEqual(await sweep(path.join(os.tmpdir(), "perf-m10-none-x"), "t"), {
    status: "absent",
    pids: [],
  });

  const foreign = ownedDir(t, "someone-else");
  assert.equal(ownedBy(foreign, "t"), false);
  assert.equal((await sweep(foreign, "t")).status, "not-owner");
  assert.equal(fs.existsSync(foreign), true);

  // A process that never goes away (lookup and signals stubbed): the folder must stay.
  const busy = ownedDir(t, "t");
  const sent: string[] = [];
  const stuck = await sweep(busy, "t", {
    graceMs: 50,
    killWaitMs: 50,
    find: () => [4242],
    signal: (_pids: number[], name: string) => sent.push(name),
  });
  assert.equal(stuck.status, "still-used");
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.existsSync(busy), true);

  const free = ownedDir(t, "t");
  assert.deepEqual(await sweep(free, "t", { find: () => [] }), { status: "swept", pids: [] });
  assert.equal(fs.existsSync(free), false);
});

test("m10-sweep CLI: plain node without node_modules stops the owner's process, then deletes", async (t) => {
  // A driver folder with nothing but the script, as on the vm.
  const driver = fs.mkdtempSync(path.join(os.tmpdir(), "perf-m10-driver-"));
  t.after(() => fs.rmSync(driver, { recursive: true, force: true }));
  const script = path.join(driver, "m10-sweep.mjs");
  fs.copyFileSync(SWEEP_SRC, script);
  assert.equal(fs.existsSync(path.join(driver, "node_modules")), false);

  const d = ownedDir(t, "tok");
  // A stand-in server that this test owns, carrying DATA_DIR=<d>.
  const child = spawn("sleep", ["60"], {
    env: { ...process.env, DATA_DIR: d },
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-(child.pid as number), "SIGKILL");
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, [script, ...args], { timeout: 30_000 }, (error, stdout) => {
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: String(stdout) });
      });
    });

  const wrong = await run([d, "other"]);
  assert.equal(wrong.code, 2);
  assert.equal(fs.existsSync(d), true);

  const ok = await run([d, "tok"]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).status, "swept");
  assert.deepEqual(JSON.parse(ok.stdout).pids, [child.pid]);
  assert.equal(fs.existsSync(d), false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.notEqual(child.signalCode, null, "the stand-in server was stopped");

  assert.equal((await run(["relative/dir", "tok"])).code, 1);
});
