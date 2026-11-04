import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-specialty-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "specialty-catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const embeddingsRoute = await import("../../src/app/api/v1/embeddings/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // These routes all derive from the shared unified catalog (getUnifiedModelsResponse),
  // which #6408 wrapped in a 1.5s TTL response cache keyed only by (prefix, isCodex
  // client, apiKey) — NOT by DB state. Every test in this file hits that same cache key,
  // so without clearing it between test cases a test running within the TTL window of
  // a previous one gets served the previous test's stale catalog instead of a fresh
  // build reflecting this test's own seeded connections.
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedConnection(provider: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function listedIds(
  route: { GET: (request?: Request) => Promise<Response> },
  pathname: string
) {
  const response = await route.GET(new Request(`http://localhost${pathname}`));
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  assert.equal(response.status, 200);
  return (body.data || []).map((model) => model.id);
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("embedding catalog GET hides providers without active credentials", async () => {
  await seedConnection("cohere");

  const ids = await listedIds(embeddingsRoute, "/v1/embeddings");

  assert.ok(ids.includes("cohere/embed-v4.0"));
  assert.ok(!ids.includes("openai/text-embedding-3-small"));
});
