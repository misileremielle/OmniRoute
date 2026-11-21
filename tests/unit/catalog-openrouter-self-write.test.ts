// A /v1/models build whose own OpenRouter capability upsert changes stored data bumps the
// catalog generation. Before the fix the cache then refused to keep that build, and the next
// call rebuilt (checkpoint open item 10). Now the build rebuilds once on the new state and
// the cache adopts it, so the next call is a cache hit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openrouter-self-write-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

const REAL_FETCH = globalThis.fetch;
let openRouterFetches = 0;

test.after(() => {
  globalThis.fetch = REAL_FETCH;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a build whose own OpenRouter upsert changes capabilities is kept", async (t) => {
  // Builds stamp `created` from the clock; freeze it so two builds can be compared.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 20) });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("openrouter.ai")) openRouterFetches++;
    const data = [
      {
        id: "acme/self-write-vision",
        name: "Self-write vision",
        context_length: 32000,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
      },
    ];
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "self-write-openrouter",
    apiKey: "sk-or-self-write",
    isActive: true,
  });
  catalog.__resetCatalogBuilderRunsForTest();
  const generationBefore = catalogCache.getCatalogCacheGeneration();

  const first = await catalog.getUnifiedModelsResponse(new Request("http://127.0.0.1/v1/models"));
  assert.equal(first.status, 200);
  const firstBody = await first.text();
  assert.ok(firstBody.includes("self-write-vision"), "the OpenRouter model is listed");
  assert.notEqual(
    catalogCache.getCatalogCacheGeneration(),
    generationBefore,
    "the build's own upsert moved the generation (the case under test)"
  );
  assert.ok(openRouterFetches >= 1);
  assert.equal(catalog.__getCatalogBuilderRunsForTest(), 1);

  const second = await catalog.getUnifiedModelsResponse(new Request("http://127.0.0.1/v1/models"));
  assert.equal(await second.text(), firstBody);
  assert.equal(
    catalog.__getCatalogBuilderRunsForTest(),
    1,
    "the next call is a cache hit, not a rebuild"
  );

  // The kept body must be the one built on the stored capabilities (the second pass), not
  // the first pass's: a fresh build on the same, now-settled state must give the same body.
  catalog.__resetCatalogBuilderRunsForTest();
  const fresh = await catalog.getUnifiedModelsResponse(new Request("http://127.0.0.1/v1/models"));
  assert.equal(catalog.__getCatalogBuilderRunsForTest(), 1, "a real rebuild");
  assert.equal(await fresh.text(), firstBody, "kept body equals a build after the upsert");
});
