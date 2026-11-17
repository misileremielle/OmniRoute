/**
 * Stage-2 T4 tests for scripts/perf/wait-idle.sh (node:test).
 *
 * Runs the script against temp loadavg files (PERF_LOADAVG_FILE), so no host
 * load is touched: idle exits 0 at once; busy with a 1 s cap exits 92; a busy
 * file rewritten to idle after ~1 s exits 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/perf/wait-idle.sh", import.meta.url));

function runScript(env) {
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT], { env: { ...process.env, ...env } }, (error, _stdout, stderr) => {
      resolve({ code: error && typeof error.code === "number" ? error.code : 0, stderr });
    });
  });
}

function tempLoadavg(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-wait-idle-"));
  const file = path.join(dir, "loadavg");
  fs.writeFileSync(file, content);
  return { dir, file };
}

test("idle loadavg exits 0 at once and reports waited seconds", async () => {
  const { dir, file } = tempLoadavg("0.05 0.10 0.15 1/200 1234\n");
  try {
    const started = Date.now();
    const { code, stderr } = await runScript({ PERF_LOADAVG_FILE: file });
    assert.equal(code, 0);
    assert.match(stderr, /idle after 0s/);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busy loadavg with a 1 s cap exits 92", async () => {
  const { dir, file } = tempLoadavg("8.00 6.00 4.00 2/200 1234\n");
  try {
    const { code, stderr } = await runScript({
      PERF_LOADAVG_FILE: file,
      PERF_WAIT_MAX_S: "1",
      PERF_WAIT_POLL_S: "1",
    });
    assert.equal(code, 92);
    assert.match(stderr, /timeout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busy file rewritten to idle exits 0", async () => {
  const { dir, file } = tempLoadavg("8.00 6.00 4.00 2/200 1234\n");
  try {
    setTimeout(() => {
      fs.writeFileSync(file, "0.10 0.20 0.30 1/200 1234\n");
    }, 1000).unref();
    const { code, stderr } = await runScript({
      PERF_LOADAVG_FILE: file,
      PERF_WAIT_MAX_S: "10",
      PERF_WAIT_POLL_S: "1",
      PERF_MAX_LOAD: "2.0",
    });
    assert.equal(code, 0);
    assert.match(stderr, /idle after \d+s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
