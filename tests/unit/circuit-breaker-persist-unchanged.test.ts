// Every successful request used to rewrite the breaker's row (INSERT OR REPLACE) even when its
// state had not changed — about three SQLite commits per proxied request. Unchanged state is now
// not written again; real transitions still persist.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-persist-unchanged-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { CircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
const { loadCircuitBreakerState } = await import("../../src/lib/db/domainState.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function changes(): number {
  return Number(
    (core.getDbInstance().prepare("SELECT total_changes() AS n").get() as { n: number }).n
  );
}

test("repeated successes on a healthy breaker write its row at most once", async () => {
  const breaker = new CircuitBreaker("persist-unchanged-healthy", { failureThreshold: 5 });
  await breaker.execute(async () => "ok");
  const before = changes();
  for (let i = 0; i < 20; i++) await breaker.execute(async () => "ok");
  assert.equal(changes() - before, 0, "unchanged CLOSED state must not be rewritten");
  assert.equal(loadCircuitBreakerState("persist-unchanged-healthy")?.state, "CLOSED");
});

test("a failure and the recovery after it are still persisted", async () => {
  const breaker = new CircuitBreaker("persist-unchanged-failure", { failureThreshold: 5 });
  await breaker.execute(async () => "ok");
  await assert.rejects(
    breaker.execute(async () => {
      throw Object.assign(new Error("upstream 503"), { status: 503 });
    })
  );
  assert.equal(loadCircuitBreakerState("persist-unchanged-failure")?.failureCount, 1);
  await breaker.execute(async () => "ok");
  assert.equal(loadCircuitBreakerState("persist-unchanged-failure")?.failureCount, 0);
});
