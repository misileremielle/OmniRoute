/**
 * Stage-2 T1: per-process/thread request I/O counters, loaded via `--import`.
 *
 * Active only when PERF_IO_COUNTER_DIR is set; otherwise this module is a no-op.
 * A Symbol.for guard makes a second load in the same thread a no-op.
 *
 * What is counted (per thread; workers get their own file):
 * - sqlite.statements / sqlite.prepare / sqlite.exec, each also split by driver
 *   in sqlite.byDriver ("better-sqlite3", "node:sqlite");
 * - fsSync[<name>] for every function-valued fs.<name>Sync (outermost call only,
 *   via a depth counter for nested calls an original makes through `fs`);
 * - fsAsync[<name>] for every function on fs.promises (counted at call entry);
 * - fsCallback[<name>] for every callback-style fs.<name> that has a <name>Sync
 *   sibling (counted at call entry; streams reach these through the fs module);
 * - workersCreated (worker_threads.Worker constructions in this thread);
 * - driversHooked (drivers patched in this thread), driversUsed (drivers with calls).
 *
 * Report: every 250 ms (unref'd timer) plus synchronously on `exit`,
 * <dir>/<pid>-<threadId>.json is rewritten through captured originals
 * (temp file + rename), so each write counts nothing. Fields: pid, ppid,
 * threadId, isMainThread, argv (process.argv.slice(1, 3)), role (PERF_IO_ROLE
 * env, else "worker" / "process"), counts, writtenAt.
 */
import fs from "node:fs";
import Module, { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import workerThreads from "node:worker_threads";
import { isMainThread, threadId } from "node:worker_threads";

const GUARD_KEY = Symbol.for("omniroute.perf.ioPreload");
const STATEMENT_METHODS = ["run", "get", "all", "iterate"];

// Per-thread counter state.
const counts = {
  sqlite: { statements: 0, prepare: 0, exec: 0, byDriver: {} },
  fsSync: {},
  fsAsync: {},
  fsCallback: {},
  workersCreated: 0,
};
const driversHooked = new Set();
const driversUsed = new Set();
let busy = false;
let fsDepth = 0;
let counterDir = "";
let fileUrl = "";

// Originals captured before any wrapping; the report path uses only these.
const origWriteFileSync = fs.writeFileSync;
const origRenameSync = fs.renameSync;
const origMkdirSync = fs.mkdirSync;
const origLoad = Module._load;

function bumpSqlite(driver, kind) {
  counts.sqlite[kind] += 1;
  let entry = counts.sqlite.byDriver[driver];
  if (!entry) {
    entry = { statements: 0, prepare: 0, exec: 0 };
    counts.sqlite.byDriver[driver] = entry;
  }
  entry[kind] += 1;
  driversUsed.add(driver);
}

// A wrapper must keep the original's own properties and symbols: for example
// fs.realpathSync.native, fs.realpath.native and the util.promisify custom
// symbols on fs.read / fs.exists. Losing them changes the program under test.
const SKIP_OWN = new Set(["length", "name", "prototype", "caller", "arguments"]);
function keepOwnProps(original, wrapped) {
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key === "string" && SKIP_OWN.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(original, key);
    if (desc) Object.defineProperty(wrapped, key, desc);
  }
  wrapped.__perfWrapped = true;
  return wrapped;
}

function wrapFsCallback(name, original) {
  return function (...args) {
    if (!busy) counts.fsCallback[name] = (counts.fsCallback[name] ?? 0) + 1;
    return Reflect.apply(original, this, args);
  };
}

function wrapFsSync(name, original) {
  return function (...args) {
    if (busy) return Reflect.apply(original, this, args);
    const outermost = fsDepth === 0;
    fsDepth += 1;
    try {
      const result = Reflect.apply(original, this, args);
      if (outermost) counts.fsSync[name] = (counts.fsSync[name] ?? 0) + 1;
      return result;
    } finally {
      fsDepth -= 1;
    }
  };
}

function wrapFsAsync(name, original) {
  return function (...args) {
    if (!busy) counts.fsAsync[name] = (counts.fsAsync[name] ?? 0) + 1;
    return Reflect.apply(original, this, args);
  };
}

function patchFs() {
  for (const name of Object.keys(fs)) {
    const original = fs[name];
    if (typeof original !== "function" || original.__perfWrapped) continue;
    if (name.endsWith("Sync")) {
      fs[name] = keepOwnProps(original, wrapFsSync(name, original));
    } else if (typeof fs[`${name}Sync`] === "function") {
      fs[name] = keepOwnProps(original, wrapFsCallback(name, original));
    }
  }
  const promises = fs.promises;
  for (const name of Object.keys(promises)) {
    const original = promises[name];
    if (typeof original !== "function" || original.__perfWrapped) continue;
    promises[name] = keepOwnProps(original, wrapFsAsync(name, original));
  }
  syncBuiltinESMExports();
}

function patchStatementProto(proto, driver) {
  if (!proto || patchedStmtProtos.has(proto)) return;
  patchedStmtProtos.add(proto);
  for (const name of STATEMENT_METHODS) {
    const original = proto[name];
    if (typeof original !== "function" || original.__perfWrapped) continue;
    const wrapped = function (...args) {
      if (!busy) bumpSqlite(driver, "statements");
      return Reflect.apply(original, this, args);
    };
    wrapped.__perfWrapped = true;
    proto[name] = wrapped;
  }
}

const patchedCtors = new Set();
const patchedStmtProtos = new WeakSet();

function patchBetterSqlite3Ctor(Ctor) {
  if (typeof Ctor !== "function" || !Ctor.prototype) return;
  if (patchedCtors.has(Ctor)) return;
  patchedCtors.add(Ctor);
  driversHooked.add("better-sqlite3");
  const proto = Ctor.prototype;
  if (typeof proto.prepare === "function" && !proto.prepare.__perfWrapped) {
    const original = proto.prepare;
    const wrapped = function (...args) {
      if (!busy) bumpSqlite("better-sqlite3", "prepare");
      const stmt = Reflect.apply(original, this, args);
      patchStatementProto(stmt ? Object.getPrototypeOf(stmt) : null, "better-sqlite3");
      return stmt;
    };
    wrapped.__perfWrapped = true;
    proto.prepare = wrapped;
  }
  if (typeof proto.exec === "function" && !proto.exec.__perfWrapped) {
    const original = proto.exec;
    const wrapped = function (...args) {
      if (!busy) bumpSqlite("better-sqlite3", "exec");
      return Reflect.apply(original, this, args);
    };
    wrapped.__perfWrapped = true;
    proto.exec = wrapped;
  }
}

function isBetterSqlite3(request, parent) {
  // Match only the package entry point, not its internal files: every helper
  // required while the entry loads resolves under the same package dir, but
  // patching those (transaction/pragma/...) would double-count via the shared
  // Database prototype's method closures.
  if (request === "better-sqlite3") return true;
  if (!parent || !parent.filename) return false;
  if (request.startsWith(".") || request.startsWith("/")) return false;
  let resolved = "";
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    return false;
  }
  const normalized = resolved.split(path.sep).join("/");
  const marker = "/node_modules/better-sqlite3/";
  const index = normalized.indexOf(marker);
  if (index === -1) return false;
  return normalized.slice(index + marker.length) === "lib/index.js";
}

function patchModuleLoad() {
  Module._load = function (...args) {
    const exported = Reflect.apply(origLoad, this, args);
    if (!busy) {
      busy = true;
      try {
        const [request, parent] = args;
        if (isBetterSqlite3(request, parent)) {
          patchBetterSqlite3Ctor(exported);
          if (exported && (typeof exported === "object" || typeof exported === "function")) {
            patchBetterSqlite3Ctor(exported.default);
            patchBetterSqlite3Ctor(exported.Database);
          }
        }
      } finally {
        busy = false;
      }
    }
    return exported;
  };
}

async function patchNodeSqlite() {
  let sqlite = null;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return; // A missing builtin is not an error.
  }
  const { DatabaseSync, StatementSync } = sqlite;
  if (typeof DatabaseSync !== "function" || !DatabaseSync.prototype) return;
  if (typeof StatementSync !== "function" || !StatementSync.prototype) return;
  driversHooked.add("node:sqlite");
  if (typeof DatabaseSync.prototype.prepare === "function") {
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (...args) {
      if (!busy) bumpSqlite("node:sqlite", "prepare");
      return Reflect.apply(original, this, args);
    };
  }
  if (typeof DatabaseSync.prototype.exec === "function") {
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (...args) {
      if (!busy) bumpSqlite("node:sqlite", "exec");
      return Reflect.apply(original, this, args);
    };
  }
  for (const name of STATEMENT_METHODS) {
    const original = StatementSync.prototype[name];
    if (typeof original !== "function") continue;
    StatementSync.prototype[name] = function (...args) {
      if (!busy) bumpSqlite("node:sqlite", "statements");
      return Reflect.apply(original, this, args);
    };
  }
}

function withPreloadArgv(options) {
  const base =
    options && Array.isArray(options.execArgv) ? [...options.execArgv] : [...process.execArgv];
  if (!base.includes(fileUrl)) base.push("--import", fileUrl);
  return { ...(options ?? {}), execArgv: base };
}

function patchWorkers() {
  const OriginalWorker = workerThreads.Worker;
  if (typeof OriginalWorker !== "function" || OriginalWorker.__perfWrappedCtor) return;
  class WrappedWorker extends OriginalWorker {
    constructor(filename, options) {
      super(filename, withPreloadArgv(options));
      counts.workersCreated += 1;
    }
  }
  WrappedWorker.__perfWrappedCtor = true;
  workerThreads.Worker = WrappedWorker;
  syncBuiltinESMExports();
}

function writeReport() {
  if (!counterDir || busy) return;
  busy = true;
  try {
    const payload = {
      pid: process.pid,
      ppid: process.ppid,
      threadId,
      isMainThread,
      argv: process.argv.slice(1, 3),
      role: process.env.PERF_IO_ROLE ?? (isMainThread ? "process" : "worker"),
      counts: {
        sqlite: counts.sqlite,
        fsSync: { ...counts.fsSync },
        fsAsync: { ...counts.fsAsync },
        fsCallback: { ...counts.fsCallback },
        workersCreated: counts.workersCreated,
        driversHooked: [...driversHooked].sort(),
        driversUsed: [...driversUsed].sort(),
      },
      writtenAt: Date.now(),
    };
    const file = path.join(counterDir, `${process.pid}-${threadId}.json`);
    const tmp = `${file}.tmp`;
    origMkdirSync(counterDir, { recursive: true });
    origWriteFileSync(tmp, JSON.stringify(payload));
    origRenameSync(tmp, file);
  } catch {
    // Reporting must never crash the process.
  } finally {
    busy = false;
  }
}

const alreadyLoaded = globalThis[GUARD_KEY] === true;
globalThis[GUARD_KEY] = true;
counterDir = process.env.PERF_IO_COUNTER_DIR ?? "";
fileUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;

if (!alreadyLoaded && counterDir) {
  // How many instances patched this thread; must stay 1 (checked by the tests).
  const PATCHED_KEY = Symbol.for("omniroute.perf.ioPreload.patched");
  globalThis[PATCHED_KEY] = (globalThis[PATCHED_KEY] ?? 0) + 1;
  patchFs();
  patchModuleLoad();
  await patchNodeSqlite();
  patchWorkers();
  const timer = setInterval(writeReport, 250);
  if (typeof timer.unref === "function") timer.unref();
  process.on("exit", writeReport);
}
