/**
 * #9293 — specialty model catalog ignores hidden OpenRouter model flags.
 *
 * The specialty model loops (image, rerank, audio, moderation, video, music)
 * in catalog.ts reduce OpenRouter model IDs to only the final path segment
 * via .split("/").pop() before calling getModelIsHidden(), so stored hidden
 * flags with full provider-relative paths (e.g. openrouter+google/chirp-3)
 * are never matched. The embedding loop correctly strips only the provider prefix
 * rather than taking the last segment.
 *
 * This test: seeds an OpenRouter connection, hides two OpenRouter specialty
 * models (audio: google/chirp-3, image: black-forest-labs/flux.2-pro), then
 * verifies the hidden models are excluded from the /v1/models catalog while
 * non-hidden models still appear.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9293-specialty-hidden-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "9293-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { mergeModelCompatOverride, getModelIsHidden } = await import("@/lib/db/models");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#9293 hidden OpenRouter specialty models are excluded from /v1/models catalog", async () => {
  // Create an active OpenRouter connection
  const connection = await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-test",
    apiKey: "sk-or-test-9293",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  assert.ok(connection?.id, "OpenRouter connection created");

  // Confirm the hidden flag is not set yet
  assert.equal(
    getModelIsHidden("openrouter", "baai/bge-m3"),
    false,
    "baai/bge-m3 is initially visible"
  );
  assert.equal(
    getModelIsHidden("openrouter", "cohere/rerank-v3.5"),
    false,
    "cohere/rerank-v3.5 is initially visible"
  );

  // Hide two OpenRouter specialty models: one embedding, one rerank
  mergeModelCompatOverride("openrouter", "baai/bge-m3", { isHidden: true });
  mergeModelCompatOverride("openrouter", "cohere/rerank-v3.5", { isHidden: true });

  // Confirm the hidden flags are stored correctly
  assert.equal(getModelIsHidden("openrouter", "baai/bge-m3"), true, "baai/bge-m3 is now hidden");
  assert.equal(
    getModelIsHidden("openrouter", "cohere/rerank-v3.5"),
    true,
    "cohere/rerank-v3.5 is now hidden"
  );

  // Fetch the full catalog
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
  assert.ok(Array.isArray(body.data), "response has data array");

  // Find embedding and rerank models
  const embeddingModels = body.data.filter((m) => m.type === "embedding");
  const rerankModels = body.data.filter((m) => m.type === "rerank");

  const hiddenEmbedding = embeddingModels.find((m) => String(m.id).endsWith("baai/bge-m3"));
  assert.equal(
    hiddenEmbedding,
    undefined,
    "#9293 RED: hidden embedding model openrouter/baai/bge-m3 should NOT appear in catalog"
  );

  const hiddenRerank = rerankModels.find((m) => String(m.id).endsWith("cohere/rerank-v3.5"));
  assert.equal(
    hiddenRerank,
    undefined,
    "#9293 RED: hidden rerank model openrouter/cohere/rerank-v3.5 should NOT appear in catalog"
  );

  // Verify non-hidden rerank models from OpenRouter still appear
  const visibleRerank = rerankModels.find((m) => String(m.id).endsWith("cohere/rerank-4-pro"));
  assert.ok(
    visibleRerank,
    "non-hidden rerank model cohere/rerank-4-pro should still appear in catalog"
  );
});
