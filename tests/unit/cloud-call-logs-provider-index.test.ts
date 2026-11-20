// Step-11 fix 3: the cloud (in-memory) database runs no migrations, so it never gets migration
// 200's idx_cl_health_matrix_cover from there. idx_cl_provider_timestamp left SCHEMA_SQL, so the
// in-memory path creates the cover index itself; provider metrics keep their provider seeks.
import test from "node:test";
import assert from "node:assert/strict";

const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
Object.defineProperty(globalThis, "caches", { value: {}, configurable: true });
const core = await import("../../src/lib/db/core.ts");
const stats = await import("../../src/lib/db/providerStats.ts");
const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

test.after(() => {
  core.resetDbInstance();
  if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

const indexNames = () =>
  (
    core
      .getDbInstance()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

test("the in-memory database is the cloud one and has the cover index, not the six", () => {
  assert.equal(core.isCloud, true);
  assert.equal(core.getDbInstance().name, ":memory:");
  const names = indexNames();
  assert.ok(names.includes("idx_cl_health_matrix_cover"));
  for (const name of [
    "idx_cl_client_session_id",
    "idx_cl_provider_timestamp",
    "idx_uh_service_tier",
    "idx_uh_combo_strategy",
    "idx_uh_endpoint",
    "idx_uh_model",
  ]) {
    assert.ok(!names.includes(name), `${name} is not created in memory`);
  }
});

test("provider stats seek the cover index on the in-memory database", () => {
  const params = {
    since: stats.buildProviderStatsSince(),
    keylessProviderIds: JSON.stringify(Object.keys(NOAUTH_PROVIDERS)),
  };
  const plan = (
    core
      .getDbInstance()
      .prepare(`EXPLAIN QUERY PLAN ${stats.PROVIDER_CALL_STATS_SQL}`)
      .all(params) as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(" | ");
  assert.ok(plan.includes("USING INDEX idx_cl_health_matrix_cover (provider>?)"), plan);
  assert.ok(!plan.includes("SCAN c"), plan);
});
