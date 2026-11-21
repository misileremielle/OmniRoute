// The /v1/models catalog is kept until a write changes it, refreshed in the background
// once per interval (default 24 h), and served old for up to 24 h more while refreshes
// fail. An error never replaces a kept catalog, and a build's own OpenRouter capability
// upsert no longer throws its result away.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CatalogBuildContext,
  CatalogPayload,
} from "../../src/app/api/v1/models/catalogCache.ts";
import { createTempDataDir } from "../_setup/tempDataDir.ts";

const { cleanup } = createTempDataDir("omniroute-catalog-keep-");
const cache = await import("../../src/app/api/v1/models/catalogCache.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const { databaseSettingsSchema } = await import("../../src/shared/validation/settingsSchemas.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const headers = { corsHeaders: {}, diagnosticHeaders: {} };
const runNow = (task: () => Promise<unknown>) => {
  void task();
};

function request(key: string) {
  return new Request(`http://localhost/v1/models?prefix=${key}`, {
    headers: { authorization: "Bearer catalog-keep-fixture" },
  });
}
function payload(body: string, status = 200, cacheTTL = DAY_MS): CatalogPayload {
  return { body, headers: {}, status, cacheTTL };
}
type Builder = (req: Request, ctx: CatalogBuildContext) => Promise<CatalogPayload>;
async function resolve(key: string, builder: Builder) {
  const response = await cache.resolveCachedCatalogResponse(request(key), headers, builder, {
    scheduleBackgroundRefresh: runNow,
  });
  return { status: response.status, body: await response.text() };
}
const fixed =
  (body: string, status = 200): Builder =>
  async () =>
    payload(body, status);
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((done) => {
    release = done;
  });
  return { opened, release };
}
/** A build that performs its own write, like the OpenRouter upsert, then waits on `wait`. */
function selfWritingBuilder(body: string, wait?: Promise<void>, after?: () => void): Builder {
  return async (_req, ctx) => {
    const before = cache.getCatalogCacheGeneration();
    readCache.invalidateModelCatalogCache();
    const to = cache.getCatalogCacheGeneration();
    assert.equal(cache.registerCatalogSelfWrite(ctx, before, to), true);
    if (wait) await wait;
    after?.();
    return { ...payload(body), adopt: { from: before, to } };
  };
}
const runs = () => cache.__getCatalogBuilderRunsForTest();

test.beforeEach(() => cache.__resetCatalogBuilderRunsForTest());
test.after(cleanup);

test("the refresh interval defaults to 24 h and the schema allows up to 7 days", () => {
  assert.equal(cache.CATALOG_CACHE_TTL_MS_DEFAULT, DAY_MS);
  assert.equal(cache.CATALOG_STALE_WHILE_REVALIDATE_MS, DAY_MS);
  const field = databaseSettingsSchema.shape.cache.shape.modelCatalogCacheTtlMs;
  assert.equal(field.safeParse(7 * DAY_MS).success, true);
  assert.equal(field.safeParse(7 * DAY_MS + 1).success, false);
  assert.equal(field.safeParse(1000).success, true);
});

test("an expired catalog inside the grace is served at once and refreshed after the reply", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(1);
  const g = gate();
  const served = await resolve("a", async () => {
    await g.opened;
    return payload("v2");
  });
  assert.deepEqual(served, { status: 200, body: "v1" }, "served without waiting for the build");
  assert.equal(runs(), 2, "the background refresh started");
  g.release();
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.deepEqual(await resolve("a", fixed("unused")), { status: 200, body: "v2" });
  assert.equal(runs(), 2);
});

test("an entry 23 h past its interval is still served at once", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(23 * 60 * 60 * 1000);
  assert.equal((await resolve("a", fixed("v2"))).body, "v1");
});

test("past interval + 24 h the caller waits for a build", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(DAY_MS + 1);
  assert.equal((await resolve("a", fixed("v2"))).body, "v2");
  assert.equal(runs(), 2);
});

test("a write still drops the kept catalog at once", async () => {
  await resolve("a", fixed("v1"));
  readCache.invalidateModelCatalogCache();
  assert.equal((await resolve("a", fixed("v2"))).body, "v2");
});

test("a background refresh that returns 500 keeps the catalog and backs off", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(1);
  assert.equal((await resolve("a", fixed("boom", 500))).body, "v1");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal(cache.__peekCatalogCacheEntryForTest(request("a"))?.status, 200);
  const next = await resolve("a", fixed("v2"));
  assert.deepEqual(next, { status: 200, body: "v1" }, "the kept 200 is still served");
  assert.equal(runs(), 2, "no new refresh inside the backoff");
});

test("a rejected background refresh keeps the catalog and backs off", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(1);
  const rejecting: Builder = async () => {
    throw new Error("refresh failed");
  };
  assert.equal((await resolve("a", rejecting)).body, "v1");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal((await resolve("a", fixed("v2"))).body, "v1");
  assert.equal(runs(), 2);
});

test("a 500 with no kept catalog is cached for at most 60 s", async () => {
  const before = Date.now();
  assert.equal((await resolve("a", fixed("boom", 500))).status, 500);
  const entry = cache.__peekCatalogCacheEntryForTest(request("a"));
  assert.equal(entry?.status, 500);
  assert.ok(entry!.expiresAt - before <= cache.CATALOG_ERROR_TTL_MS + 50);
});

test("a build's own write is adopted: the next call is a cache hit", async () => {
  assert.equal((await resolve("a", selfWritingBuilder("own"))).body, "own");
  assert.equal((await resolve("a", fixed("unused"))).body, "own");
  assert.equal(runs(), 1);
});

test("while a build's own write is pending, other keys keep their catalog", async () => {
  await resolve("b", fixed("b1"));
  const g = gate();
  const pendingA = resolve("a", selfWritingBuilder("a1", g.opened));
  await new Promise((done) => setImmediate(done));
  assert.equal((await resolve("b", fixed("unused"))).body, "b1", "no cold build for b");
  assert.equal(runs(), 2);
  g.release();
  assert.equal((await pendingA).body, "a1");
  // b was built before a's write: served at once, refreshed in the background.
  const served = await resolve("b", fixed("b2"));
  assert.equal(served.body, "b1");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal(runs(), 3);
  assert.equal((await resolve("b", fixed("unused"))).body, "b2");
});

test("a same-key caller joins the pending build instead of starting another", async () => {
  const g = gate();
  const first = resolve("a", selfWritingBuilder("a1", g.opened));
  await new Promise((done) => setImmediate(done));
  const second = resolve("a", fixed("unused"));
  g.release();
  assert.equal((await first).body, "a1");
  assert.equal((await second).body, "a1");
  assert.equal(runs(), 1);
});

test("a build that fails after its own write keeps other keys' catalogs", async () => {
  await resolve("b", fixed("b1"));
  const failing: Builder = async (req, ctx) => {
    await selfWritingBuilder("x")(req, ctx);
    return payload("boom", 500);
  };
  assert.equal((await resolve("a", failing)).status, 500);
  assert.equal((await resolve("b", fixed("b2"))).body, "b1", "kept, served at once");
});

test("a build that rejects after its own write keeps other keys' catalogs", async () => {
  await resolve("b", fixed("b1"));
  const rejecting: Builder = async (req, ctx) => {
    await selfWritingBuilder("x")(req, ctx);
    throw new Error("build failed");
  };
  await assert.rejects(() => resolve("a", rejecting));
  assert.equal((await resolve("b", fixed("b2"))).body, "b1");
});

test("a background refresh that rejects after its own write settles it and backs off", async () => {
  await resolve("a", fixed("a1"));
  cache.__expireCatalogCacheForTest(1);
  await resolve("b", fixed("b1")); // fresh, built at the old generation
  const rejecting: Builder = async (req, ctx) => {
    await selfWritingBuilder("x")(req, ctx);
    throw new Error("refresh failed");
  };
  assert.equal((await resolve("a", rejecting)).body, "a1", "stale list served at once");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal(runs(), 3);
  assert.equal(cache.__getPendingSelfWriteCountForTest(), 0, "the pending mark is cleared");
  // The write is accepted: b, built before it, is served at once and refreshed in the background.
  assert.equal((await resolve("b", fixed("b2"))).body, "b1", "no cold build for b");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal(runs(), 4, "b was marked expired and refreshed");
  assert.equal((await resolve("b", fixed("unused"))).body, "b2");
  // a backs off after its failed refresh.
  assert.equal((await resolve("a", fixed("a2"))).body, "a1");
  assert.equal(runs(), 4, "no new refresh for a inside the backoff");
});

test("a 500 from the rebuild after its own write still backs off the refresh", async () => {
  await resolve("a", fixed("v1"));
  cache.__expireCatalogCacheForTest(1);
  const failingSecondPass: Builder = async (req, ctx) => {
    const own = await selfWritingBuilder("x")(req, ctx);
    return { ...own, ...payload("boom", 500) };
  };
  assert.equal((await resolve("a", failingSecondPass)).body, "v1");
  await cache.__flushCatalogBackgroundRefreshForTest();
  assert.equal((await resolve("a", fixed("v2"))).body, "v1");
  assert.equal(runs(), 2, "no new refresh inside the backoff");
});

test("a foreign write while a build's own write is pending clears as today", async () => {
  await resolve("b", fixed("b1"));
  const g = gate();
  const pendingA = resolve("a", selfWritingBuilder("a1", g.opened));
  await new Promise((done) => setImmediate(done));
  readCache.invalidateModelCatalogCache();
  g.release();
  assert.equal((await pendingA).body, "a1", "its caller still gets its body");
  assert.equal((await resolve("b", fixed("b2"))).body, "b2", "b waited for a fresh build");
  assert.equal(cache.__peekCatalogCacheEntryForTest(request("a")), undefined, "a not stored");
});

test("a rebuild that changes data again is not adopted", async () => {
  await resolve("b", fixed("b1"));
  const rebump = selfWritingBuilder("a1", undefined, () => readCache.invalidateModelCatalogCache());
  assert.equal((await resolve("a", rebump)).body, "a1");
  assert.equal((await resolve("b", fixed("b2"))).body, "b2", "cleared, as a write");
  assert.equal(cache.__peekCatalogCacheEntryForTest(request("a")), undefined);
});
