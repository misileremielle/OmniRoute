import { afterEach, after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { startCleanupScheduler, stopCleanupScheduler } from "../../src/lib/db/cleanup.ts";
import * as vacuumScheduler from "../../src/lib/db/vacuumScheduler.ts";
import {
  startRuntimeConfigHotReload,
  stopRuntimeConfigHotReloadForTests,
} from "../../src/lib/config/hotReload.ts";

const FLAG = "OMNIROUTE_DISABLE_BACKGROUND_SERVICES";
const originalFlag = process.env[FLAG];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

type TimerCall = { delay: number };

/** Records the timers a scheduler arms, without letting them fire. */
function captureTimers() {
  const timeouts: TimerCall[] = [];
  const intervals: TimerCall[] = [];
  const handle = () => ({ unref() {}, ref() {}, hasRef: () => false }) as unknown as NodeJS.Timeout;
  globalThis.setTimeout = ((_fn: unknown, delay = 0) => {
    timeouts.push({ delay });
    return handle();
  }) as typeof setTimeout;
  globalThis.setInterval = ((_fn: unknown, delay = 0) => {
    intervals.push({ delay });
    return handle();
  }) as typeof setInterval;
  return { timeouts, intervals };
}

function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
}

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
}

before(() => {
  getDbInstance();
});

beforeEach(() => {
  vacuumScheduler.__resetForTests();
});

afterEach(() => {
  restoreTimers();
  stopCleanupScheduler();
  stopRuntimeConfigHotReloadForTests();
  vacuumScheduler.__resetForTests();
  setFlag(originalFlag);
});

after(() => {
  resetDbInstance();
});

test("cleanup scheduler arms no timer with the flag on", () => {
  setFlag("1");
  const timers = captureTimers();
  startCleanupScheduler();
  restoreTimers();
  assert.deepEqual(timers.timeouts, []);
  assert.deepEqual(timers.intervals, []);
});

test("cleanup scheduler still arms its startup and periodic timers with the flag off", () => {
  setFlag(undefined);
  const timers = captureTimers();
  startCleanupScheduler();
  restoreTimers();
  assert.equal(timers.timeouts.filter((t) => t.delay === 30_000).length, 1);
  assert.equal(timers.intervals.filter((t) => t.delay === 6 * 60 * 60 * 1000).length, 1);
});

test("vacuum scheduler arms no timer on init or refresh with the flag on", () => {
  setFlag("yes");

  const afterInit = vacuumScheduler.initVacuumScheduler();
  assert.equal(afterInit.enabled, true, "the schedule itself stays configured");
  assert.equal(afterInit.nextRunAt, null, "init must not schedule a run");

  // The settings API calls refresh(), so that path must not re-arm the timer behind the flag.
  const afterRefresh = vacuumScheduler.refreshVacuumScheduler();
  assert.equal(afterRefresh.nextRunAt, null, "refresh must not schedule a run");
});

test("vacuum scheduler still schedules a run with the flag off", () => {
  setFlag(undefined);
  const state = vacuumScheduler.initVacuumScheduler();
  assert.equal(typeof state.nextRunAt, "number");
});

test("hot reload arms no poll with the flag on and starts only once", () => {
  setFlag("true");
  const timers = captureTimers();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    startRuntimeConfigHotReload({ pollIntervalMs: 54_321 });
    startRuntimeConfigHotReload({ pollIntervalMs: 54_321 });
  } finally {
    console.log = realLog;
    restoreTimers();
  }
  assert.deepEqual(
    timers.intervals.filter((t) => t.delay === 54_321),
    []
  );
  const started = logs.filter((line) => line.includes("hot-reload started"));
  assert.equal(started.length, 1, "a second start must be a no-op");
  assert.match(started[0], /poll=off/);
});

test("hot reload still arms its poll with the flag off", () => {
  setFlag(undefined);
  const timers = captureTimers();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    startRuntimeConfigHotReload({ pollIntervalMs: 54_321 });
  } finally {
    console.log = realLog;
    restoreTimers();
  }
  assert.equal(timers.intervals.filter((t) => t.delay === 54_321).length, 1);
  assert.match(logs.find((line) => line.includes("hot-reload started")) ?? "", /poll=54321ms/);
});
