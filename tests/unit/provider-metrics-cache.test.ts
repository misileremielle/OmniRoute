// /api/provider-metrics aggregates every call_logs row; the dashboard home polls it every few
// seconds per open tab. The aggregate is now served from a short shared cache.
import assert from "node:assert/strict";
import test from "node:test";

const { createProviderMetricsCache } = await import("../../src/lib/db/callLogStats.ts");

test("repeated reads within the TTL run the aggregate once", () => {
  let now = 1_000;
  let runs = 0;
  const read = createProviderMetricsCache(
    () => {
      runs += 1;
      return [{ provider: "openai", totalRequests: runs } as never];
    },
    { ttlMs: 10_000, now: () => now }
  );
  const first = read();
  now += 9_999;
  assert.equal(read(), first);
  assert.equal(runs, 1);
  now += 1;
  assert.notEqual(read(), first);
  assert.equal(runs, 2);
});

test("a failing aggregate is not cached", () => {
  let fail = true;
  let runs = 0;
  const read = createProviderMetricsCache(
    () => {
      runs += 1;
      if (fail) throw new Error("database is locked");
      return [];
    },
    { ttlMs: 10_000, now: () => 0 }
  );
  assert.throws(read, /locked/);
  fail = false;
  assert.deepEqual(read(), []);
  assert.equal(runs, 2);
});

test("reset() drops the cached aggregate", () => {
  let runs = 0;
  const read = createProviderMetricsCache(
    () => {
      runs += 1;
      return [];
    },
    { ttlMs: 10_000, now: () => 0 }
  );
  read();
  read.reset();
  read();
  assert.equal(runs, 2);
});
