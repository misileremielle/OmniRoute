// scripts/perf/vm-session.sh before step 11 (2026-11-19): suite parts run under stall-guard.sh,
// and gate caps have a 60 s floor. The real script text is cut out and run as bash, with fake
// `node` and `pnpm` on PATH, so no sandbox, build or test suite is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SCRIPT = fs.readFileSync(path.join(repo, "scripts", "perf", "vm-session.sh"), "utf8");
const GUARD = path.join(repo, "scripts", "perf", "stall-guard.sh");

/** The single-quoted `bash -c` body of suite(), exactly as the driver runs it. */
function suiteBody(): string {
  const m = SCRIPT.match(
    /^suite\(\) +\{ measure [^\n]* -- bash -c '\n([\s\S]*?)' suite "\$OUT\/\$1"/m
  );
  assert.ok(m, "suite() body not found in vm-session.sh");
  return m[1];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fake node/pnpm: FAKE_<part>=ok|fail|hang|crash picks what each part does. */
function fakeBin(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const body = (part: string) => `#!/usr/bin/env bash
mode="\${FAKE_${part}:-ok}"
case "$mode" in
  ok) echo "fake ${part} ok"; exit 0 ;;
  fail) echo "fake ${part} failing tests"; exit 1 ;;
  crash) exit 3 ;;
  ignoreterm) trap '' TERM; while :; do echo .; sleep 0.2; done ;;
  selfkill) kill -KILL -- "-$(ps -o pgid= -p $$ | tr -d ' ')" ;;  # an operator's SIGKILL to the part's group
  hang) echo "fake ${part} start"; sleep 300 & echo $! > "$FAKE_PIDS/${part}.pid"; wait ;;
esac
`;
  // Parts 1 and 2 call node; tell them apart by the dashboard glob part 2 passes.
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/usr/bin/env bash
case "$*" in *tests/unit/dashboard/*) exec "${bin}/part2" ;; *) exec "${bin}/part1" ;; esac
`
  );
  fs.writeFileSync(path.join(bin, "part1"), body("P1"));
  fs.writeFileSync(path.join(bin, "part2"), body("P2"));
  fs.writeFileSync(path.join(bin, "pnpm"), body("P3"));
  for (const f of ["node", "part1", "part2", "pnpm"]) fs.chmodSync(path.join(bin, f), 0o755);
  return bin;
}

function runSuite(
  t: { after: (fn: () => void) => void },
  modes: Record<string, string>,
  stallS = 1,
  deadlineS = 600
): { rc: number | null; lines: string[]; dir: string; pids: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-vm-suite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = fakeBin(dir);
  const pids = path.join(dir, "pids");
  fs.mkdirSync(pids);
  const out = path.join(dir, "suite-r1");
  const r = spawnSync(
    "bash",
    ["-c", suiteBody(), "suite", out, String(deadlineS), GUARD, String(stallS)],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_PIDS: pids,
        STALL_POLL_S: "0.2",
        ...modes,
      },
    }
  );
  const txt = path.join(dir, "suite-r1.txt");
  const lines = fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").trim().split("\n") : [];
  return { rc: r.status, lines, dir, pids };
}

test("vm-session suite: constants and wiring (10 min stall limit, guard from the driver checkout)", () => {
  assert.match(SCRIPT, /^SUITE_STALL_S=600$/m);
  assert.match(
    SCRIPT,
    /' suite "\$OUT\/\$1" "\$TO_SUITE_S" "\$DRIVER_DIR\/stall-guard\.sh" "\$SUITE_STALL_S"; \}/
  );
  const body = suiteBody();
  for (const p of ["1", "2", "3"]) {
    assert.match(
      body,
      new RegExp(
        `\\n\\s+${p}\\) bash "\\$g" "\\$stall" "\\$out\\.part\\$p\\.log" -- timeout --kill-after=30s "\\$to" `
      )
    );
  }
  // The guard's post-signal reap (15 s + up to 10 s) stays below the outer measure() timeout's
  // 30 s --kill-after, so it is done even if that timeout is still alive to SIGKILL its group.
  assert.match(SCRIPT, /\(cd "\$dir" && timeout --kill-after=30s "\$to" "\$@"\)/);
  assert.match(fs.readFileSync(GUARD, "utf8"), /^KILL_AFTER="\$\{STALL_KILL_AFTER_S:-15\}"$/m);
  // A failing self-test stops the session in preflight, not in part 1.
  assert.match(SCRIPT, /bash "\$DRIVER_DIR\/stall-guard\.sh" 5 \/dev\/null -- true/);
});

test("vm-session suite: normal parts and failing tests are timed, exit 0", (t) => {
  const r = runSuite(t, { FAKE_P1: "fail" });
  assert.equal(r.rc, 0);
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0], /^part1 [\d.]+ rc=1$/);
  assert.match(r.lines[1], /^part2 [\d.]+ rc=0$/);
  assert.match(r.lines[2], /^part3 [\d.]+ rc=0$/);
});

test("vm-session suite: a part whose log stops growing is killed, exit 75, later parts skipped", (t) => {
  const r = runSuite(t, { FAKE_P1: "hang" });
  assert.equal(r.rc, 75);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^part1 [\d.]+ rc=75$/);
  const log = fs.readFileSync(path.join(r.dir, "suite-r1.part1.log"), "utf8");
  assert.match(log, /stall-guard: .* did not grow for \d+s; killing group/);
  const hung = Number(fs.readFileSync(path.join(r.pids, "P1.pid"), "utf8"));
  assert.equal(alive(hung), false, "the hung process is gone");
});

test("vm-session suite: a stall in part 3 (pnpm) is caught too", (t) => {
  const r = runSuite(t, { FAKE_P3: "hang" });
  assert.equal(r.rc, 75);
  assert.match(r.lines[2], /^part3 [\d.]+ rc=75$/);
});

test("vm-session suite: other exits still count as no suite run (70)", (t) => {
  const r = runSuite(t, { FAKE_P2: "crash" });
  assert.equal(r.rc, 70);
  assert.match(r.lines[1], /^part2 [\d.]+ rc=3$/);
});

test("vm-session suite: a manual SIGKILL of the part's group counts as no suite run (70)", (t) => {
  const r = runSuite(t, { FAKE_P1: "selfkill" }, 600);
  assert.equal(r.rc, 70);
  assert.match(r.lines[0], /^part1 [\d.]+ rc=137$/);
});

test("vm-session suite: a part SIGKILLed by its timeout's --kill-after is the deadline (124)", (t) => {
  // The fake ignores TERM, so `timeout --kill-after=30s 2s` has to SIGKILL it: rc 137 after
  // the deadline must stop the session like a timeout, not be rerun as a failure.
  const r = runSuite(t, { FAKE_P1: "ignoreterm" }, 600, 2);
  assert.equal(r.rc, 124);
  assert.match(r.lines[0], /^part1 [\d.]+ rc=137$/);
});

test("vm-session gates: caps below 60 s are raised to 60 s, longer ones are kept", () => {
  const m = SCRIPT.match(
    /^GATE_MIN_S=60\n[\s\S]*?^for _i in "\$\{!GATE_TIMEOUTS\[@\]\}"; do [^\n]*\n/m
  );
  assert.ok(m, "gate floor block not found");
  const run = (timeout: string, list: string) =>
    execFileSync(
      "bash",
      [
        "-c",
        `GATE_TIMEOUT=${timeout}; GATE_TIMEOUTS=(${list})\n${m[0]}\necho "$GATE_TIMEOUT|\${GATE_TIMEOUTS[*]}"`,
      ],
      { encoding: "utf8" }
    ).trim();
  assert.equal(run("60m", ""), "60m|");
  assert.equal(run("1s", ""), "60s|");
  assert.equal(run("59", ""), "60s|");
  assert.equal(run("60s", ""), "60s|");
  assert.equal(run("60m", "236s 14s 0002s"), "60m|236s 60s 60s");
  assert.equal(run("60m", "2m 08s 1h"), "60m|2m 60s 1h");
});
