// Addendum A1 (cold /v1/models): the m10 parts of scripts/perf/vm-session.sh, run as bash.
// Functions are cut out of the script text and run with stand-ins for say/LOG, so the test
// exercises the real code without the account checks or a sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SCRIPT = fs.readFileSync(path.join(repo, "scripts", "perf", "vm-session.sh"), "utf8");
const FIXTURE = path.join(repo, "tests", "unit", "fixtures", "perf-io", "vm-catalog-providers.txt");

function fn(name: string): string {
  const match = SCRIPT.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `${name}() not found in vm-session.sh`);
  return match[0];
}

function bash(script: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

test("vm-session: fixture hash constant matches the fixture; tools() copies the cold probe", () => {
  const constant = SCRIPT.match(/^M10_FIXTURE_SHA256=([0-9a-f]{64})$/m)?.[1];
  const actual = createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex");
  assert.equal(constant, actual);
  assert.match(fn("tools"), /catalog-cold-probe\.ts/);
  assert.match(SCRIPT, /^TO_M10=19m$/m);
  assert.match(SCRIPT, /^M10_KILL_AFTER=45s$/m);
  // 19 min + 45 s + this 15 s sweep timeout = A1's 20-minute bound per run.
  assert.match(fn("m10_sweep"), /timeout 15s node "\$DRIVER_DIR\/m10-sweep\.mjs"/);
  // m10 runs only after measure returned for the probe label.
  // (probe() is a one-liner-style function, so check the script text.)
  assert.match(
    SCRIPT,
    /^probe\(\)[^\n]*\n\s+measure "\$1" probe [^\n]*\n[^\n]*\n[^\n]*\n\s+m10 "\$1" "\$2"/m
  );
});

test("vm-session: A2 writes step wired after m10, copied into arms, bounded", () => {
  assert.match(SCRIPT, /^TO_WRITES=26m$/m);
  assert.match(SCRIPT, /^WRITES_KILL_AFTER=45s$/m);
  assert.match(fn("tools"), /write-bytes-probe\.ts/);
  assert.match(SCRIPT, /^\s+m10 "\$1" "\$2"[^\n]*\n\s+writes "\$1" "\$2"/m);
  const w = fn("writes");
  assert.match(w, /timeout --kill-after="\$WRITES_KILL_AFTER" "\$TO_WRITES" "\$\{NB\[@\]\}"/);
  assert.match(w, /--data-dir-d "\$\(writes_dir "\$attempt" D\)" --data-dir-l/);
  // Both owned folders swept on every ending (two 15 s sweeps in A2's bound).
  assert.match(
    w,
    /for s in D L; do m10_sweep "\$label" "\$\(writes_dir "\$attempt" "\$s"\)" "\$token"; done/
  );
});

test("vm-session: keep_attempt moves an attempt's files aside, never overwrites, never deletes", (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "perf-vm-keep-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const put = (name: string, body: string) => fs.writeFileSync(path.join(out, name), body);
  put("build-1.json", "a1");
  put("build-1.log", "a1 log");
  put("build-10.json", "other label"); // a longer label sharing the prefix: not touched
  put("probe-r1.json", "p");
  put("probe-r1-m10.json", "m10"); // <label>-* belongs to the label
  const run = (label: string, n: number) =>
    bash(
      `die() { echo "DIE $*" >&2; exit 1; }\nOUT="${out}"\n${fn("keep_attempt")}\nkeep_attempt ${label} ${n}`
    );
  run("build-1", 1);
  assert.equal(
    fs.readFileSync(path.join(out, "attempts", "build-1-a1", "build-1.json"), "utf8"),
    "a1"
  );
  assert.ok(fs.existsSync(path.join(out, "attempts", "build-1-a1", "build-1.log")));
  assert.equal(fs.existsSync(path.join(out, "build-1.json")), false);
  assert.equal(fs.readFileSync(path.join(out, "build-10.json"), "utf8"), "other label");
  // Same attempt number again (a resumed session): a numbered sibling, the first kept as is.
  put("build-1.json", "again");
  run("build-1", 1);
  assert.equal(
    fs.readFileSync(path.join(out, "attempts", "build-1-a1", "build-1.json"), "utf8"),
    "a1"
  );
  assert.equal(
    fs.readFileSync(path.join(out, "attempts", "build-1-a1.1", "build-1.json"), "utf8"),
    "again"
  );
  // Nothing to move: no folder is created.
  run("build-2", 1);
  assert.equal(fs.existsSync(path.join(out, "attempts", "build-2-a1")), false);
  run("probe-r1", 1);
  assert.ok(fs.existsSync(path.join(out, "attempts", "probe-r1-a1", "probe-r1-m10.json")));
  // measure, m10 and writes all keep files instead of deleting them.
  assert.doesNotMatch(fn("measure"), /rm -rf/);
  assert.match(fn("measure"), /keep_attempt "\$label" "\$\(\(attempt - 1\)\)"/);
  assert.match(fn("m10"), /keep_attempt "\$label"/);
  assert.match(fn("writes"), /keep_attempt "\$label"/);
  assert.doesNotMatch(fn("m10") + fn("writes"), /rm -f "\$\{OUT:\?\}\/\$label\.json"/);
});

test("vm-session: reruns_used never counts m10 or writes rows", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-vm-m10-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = path.join(dir, "runs.tsv");
  const row = (label: string, kind: string, status: string, attempt: number) =>
    [label, kind, "arm-a", "t0", "-", "0.1", status, attempt].join("\t");
  fs.writeFileSync(
    runs,
    [
      "label\tkind\tarm\tstarted\tended\tload1\tstatus\tattempt",
      row("probe-r1", "probe", "started", 2),
      row("probe-r1-m10", "m10", "started", 2),
      row("probe-r2-m10", "m10", "started", 2),
      row("probe-r1-writes", "writes", "started", 2),
      row("build-1", "build", "started", 2),
    ].join("\n") + "\n"
  );
  const out = bash(`${fn("reruns_used")}\nreruns_used bench; reruns_used build`, { RUNS: runs });
  assert.deepEqual(out.trim().split("\n"), ["1", "1"]);
});

async function sweepCase(token: string, markerToken: string) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "perf-vm-sweep-"));
  const d = path.join(parent, "probe-r1-m10-a1");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, ".perf-m10-owner"), JSON.stringify({ token: markerToken }));
  // A stand-in server that this test owns: it carries DATA_DIR=<d> like a real one.
  const child = spawn("sleep", ["60"], {
    env: { ...process.env, DATA_DIR: d },
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const log = path.join(parent, "log");
  // As on the vm: the driver folder has the scripts but no node_modules anywhere above it.
  const driver = path.join(parent, "driver");
  fs.mkdirSync(driver);
  fs.copyFileSync(
    path.join(repo, "scripts", "perf", "m10-sweep.mjs"),
    path.join(driver, "m10-sweep.mjs")
  );
  bash(
    `say() { echo "$*" >> "${log}"; }\nLOG="${log}"\nDRIVER_DIR="${driver}"\n${fn("m10_sweep")}\nm10_sweep probe-r1-m10 "${d}" "${token}"`
  );
  // execFileSync blocked the event loop; let a pending exit event arrive before looking.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const alive = child.exitCode === null && child.signalCode === null;
  return { parent, d, child, alive, log };
}

test("vm-session: m10_sweep stops and deletes only a folder whose marker has this token", async (t) => {
  const mine = await sweepCase("sess:probe-r1-m10:a1", "sess:probe-r1-m10:a1");
  t.after(() => fs.rmSync(mine.parent, { recursive: true, force: true }));
  assert.equal(fs.existsSync(mine.d), false, "own folder deleted");
  assert.equal(mine.alive, false, "own stand-in server stopped");

  const theirs = await sweepCase("sess:probe-r1-m10:a1", "other:probe-r1-m10:a1");
  t.after(() => {
    // Only the pid this test spawned.
    if (theirs.child.exitCode === null) process.kill(-(theirs.child.pid as number), "SIGKILL");
    fs.rmSync(theirs.parent, { recursive: true, force: true });
  });
  assert.equal(fs.existsSync(theirs.d), true, "foreign folder left alone");
  assert.equal(theirs.alive, true, "foreign process left alone");
  assert.match(fs.readFileSync(theirs.log, "utf8"), /no owner marker for this attempt; left alone/);
});
