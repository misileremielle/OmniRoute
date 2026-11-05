// A restart must not re-run a full model sync (one upstream /models request per account)
// when the last cycle finished within the sync interval; the regular interval covers it.
import assert from "node:assert/strict";
import test from "node:test";

const { isStartupModelSyncDue } = await import("../../src/shared/services/modelSyncScheduler.ts");

const HOUR = 3_600_000;
const now = Date.parse("2026-11-05T12:00:00.000Z");

test("startup model sync runs when no cycle was ever recorded", () => {
  assert.equal(isStartupModelSyncDue(null, 6 * HOUR, now), true);
  assert.equal(isStartupModelSyncDue("not-a-date", 6 * HOUR, now), true);
});

test("startup model sync is skipped when the last cycle is newer than the interval", () => {
  assert.equal(isStartupModelSyncDue(new Date(now - 2 * HOUR).toISOString(), 6 * HOUR, now), false);
});

test("startup model sync runs when the last cycle is older than the interval", () => {
  assert.equal(isStartupModelSyncDue(new Date(now - 7 * HOUR).toISOString(), 6 * HOUR, now), true);
});

test("a last-run timestamp in the future does not suppress the startup sync", () => {
  assert.equal(isStartupModelSyncDue(new Date(now + HOUR).toISOString(), 6 * HOUR, now), true);
});
