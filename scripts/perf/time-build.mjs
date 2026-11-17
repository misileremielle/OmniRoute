#!/usr/bin/env node
/**
 * Stage-2 T4: time `npm run --silent build:release` (M1) and write a JSON report.
 *
 * Usage: node scripts/perf/time-build.mjs --root <dir> --out <file>
 *
 * Runs the release build in `root` with the same child env as `lts-baseline`
 * (`buildChildEnv` import — side-effect free; that module only runs its main
 * when executed directly), times it with `performance.now()`, and writes
 * `{ status, durationMs, exitCode, signal, sha, startedAt }` plus the last
 * 2000 chars of combined output as `tail`. The child runs in its own process
 * group; a 60-minute timeout SIGTERMs the group, then SIGKILLs after 5 s.
 *
 * The spawn target is injectable (`runTimedBuild` takes `command`/`args`/
 * `timeoutMs`/`spawnImpl`), so unit tests run fake commands — never a build.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./lts-baseline.mjs";

export const BUILD_COMMAND = "npm";
export const BUILD_ARGS = Object.freeze(["run", "--silent", "build:release"]);
export const BUILD_TIMEOUT_MS = 60 * 60_000;
export const KILL_GRACE_MS = 5_000;
const MAX_CAPTURE_CHARS = 2_000_000;
const OUTPUT_TAIL_CHARS = 2_000;

const USAGE = `Usage: node scripts/perf/time-build.mjs --root <dir> --out <file>

  --root <dir>   worktree whose release build is timed
  --out <file>   JSON report destination`;

export function parseArgs(argv) {
  const options = { root: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--root" || flag === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      i += 1;
      if (flag === "--root") options.root = value;
      else options.out = value;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (options.help) return options;
  if (!options.root) throw new Error("--root <dir> is required");
  if (!options.out) throw new Error("--out <file> is required");
  return options;
}

function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* group already gone */
  }
}

function readGitSha(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Run one command detached (own process group), capture its output, time out.
 * Never throws for child failures: they come back as `failed` (or `timeout`).
 */
export function runTimedBuild({
  cwd,
  env,
  command = BUILD_COMMAND,
  args = [...BUILD_ARGS],
  timeoutMs = BUILD_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
  spawnImpl = spawn,
  now = () => performance.now(),
} = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const started = now();
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      resolve({
        status: "failed",
        durationMs: now() - started,
        startedAt,
        exitCode: null,
        signal: null,
        tail: `could not start: ${errorMessage(e)}`.slice(-OUTPUT_TAIL_CHARS),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const cap = (s) => (s.length > MAX_CAPTURE_CHARS ? s.slice(-MAX_CAPTURE_CHARS) : s);
    child.stdout.on("data", (d) => {
      stdout = cap(stdout + d);
    });
    child.stderr.on("data", (d) => {
      stderr = cap(stderr + d);
    });
    let timedOut = false;
    let spawnError = null;
    let hardKill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      hardKill = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);
    child.once("error", (e) => {
      spawnError = e;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      // Reap any grandchild the npm wrapper left behind.
      killGroup(child, "SIGKILL");
      let tail = `${stdout}\n${stderr}`.slice(-OUTPUT_TAIL_CHARS);
      if (spawnError) {
        tail = `${tail}\nspawn error: ${errorMessage(spawnError)}`.slice(-OUTPUT_TAIL_CHARS);
      }
      const durationMs = now() - started;
      if (timedOut) {
        resolve({ status: "timeout", durationMs, startedAt, exitCode, signal, tail });
      } else if (exitCode === 0) {
        resolve({ status: "ok", durationMs, startedAt, exitCode, signal, tail });
      } else {
        resolve({ status: "failed", durationMs, startedAt, exitCode, signal, tail });
      }
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[time-build] ${errorMessage(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const root = path.resolve(options.root);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-time-build-"));
  fs.mkdirSync(dataDir, { recursive: true });
  const log = (msg) => console.error(`[time-build] ${msg}`);
  log(`root=${root} dataDir=${dataDir}`);
  try {
    const result = await runTimedBuild({ cwd: root, env: buildChildEnv(process.env, dataDir) });
    const report = {
      status: result.status,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      sha: readGitSha(root),
      startedAt: result.startedAt,
      tail: result.tail,
    };
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    log(`status=${report.status} durationMs=${Math.round(report.durationMs)} wrote ${options.out}`);
    // A failed or timed-out build must stop the session: later runs would bench a stale dist/.
    if (report.status !== "ok") process.exitCode = 1;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[time-build] fatal: ${errorMessage(e)}`);
    process.exit(1);
  });
}
