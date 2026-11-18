/**
 * Addendum A1: after-failure sweep of one cold-catalog run's data folder.
 *
 *   node scripts/perf/m10-sweep.mjs <data-dir> <owner-token>
 *
 * Plain Node, no dependencies (the driver checkout on the vm has no node_modules). Steps:
 * 1. The folder's `.perf-m10-owner` marker must carry <owner-token>; otherwise nothing is
 *    touched (exit 2).
 * 2. SIGTERM the process group of every process whose environment has DATA_DIR=<data-dir>
 *    (Linux /proc), wait up to 9 s, then SIGKILL survivors and wait up to 4 s more. With node
 *    start-up this fits the driver's 15 s timeout (A1's 20-minute bound per run).
 * 3. Delete the folder only when no process uses it any more (exit 0); otherwise leave it and
 *    exit 3, so the driver's next no_leftovers stops the session.
 * Exit 1 on bad arguments. Prints one JSON line.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_MARKER = ".perf-m10-owner";
export const SWEEP_GRACE_MS = 9_000;
export const SWEEP_KILL_WAIT_MS = 4_000;

/** Pids (not this process) whose environment has DATA_DIR=<dir>. Unreadable entries skipped. */
export function pidsUsing(dir, procRoot = "/proc") {
  const wanted = `DATA_DIR=${dir}`;
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const environ = fs.readFileSync(path.join(procRoot, entry, "environ"), "latin1");
      if (environ.split("\0").includes(wanted)) pids.push(pid);
    } catch {
      // gone or not ours
    }
  }
  return pids;
}

/** True when the folder's owner marker carries `token`. */
export function ownedBy(dir, token) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, OWNER_MARKER), "utf8"));
    return typeof marker?.token === "string" && marker.token === token;
  } catch {
    return false;
  }
}

function signalAll(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(-pid, signal); // detached servers lead their own group
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGone(dir, ms, find) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (find(dir).length === 0) return true;
    await sleep(200);
  }
  return find(dir).length === 0;
}

/**
 * Returns { status, pids } with status "absent" | "not-owner" | "swept" | "still-used".
 * Options exist for tests: graceMs, killWaitMs, find (pid lookup), signal (pids, name).
 */
export async function sweep(dir, token, opts = {}) {
  const graceMs = opts.graceMs ?? SWEEP_GRACE_MS;
  const killWaitMs = opts.killWaitMs ?? SWEEP_KILL_WAIT_MS;
  const find = opts.find ?? ((d) => pidsUsing(d));
  const signal = opts.signal ?? signalAll;
  if (!fs.existsSync(dir)) return { status: "absent", pids: [] };
  if (!ownedBy(dir, token)) return { status: "not-owner", pids: [] };
  const pids = find(dir);
  if (pids.length > 0) {
    signal(pids, "SIGTERM");
    if (!(await waitGone(dir, graceMs, find))) {
      signal(find(dir), "SIGKILL");
      await waitGone(dir, killWaitMs, find);
    }
  }
  if (find(dir).length > 0) return { status: "still-used", pids };
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: "swept", pids };
}

const EXIT = { absent: 0, swept: 0, "not-owner": 2, "still-used": 3 };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, token] = process.argv.slice(2);
  if (!dir || !token || !path.isAbsolute(dir)) {
    console.error("usage: node scripts/perf/m10-sweep.mjs <absolute data-dir> <owner-token>");
    process.exit(1);
  }
  const result = await sweep(dir, token);
  console.log(JSON.stringify({ dir, ...result }));
  process.exit(EXIT[result.status]);
}
