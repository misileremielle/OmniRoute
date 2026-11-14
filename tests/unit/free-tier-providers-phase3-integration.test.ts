import assert from "node:assert/strict";
import test from "node:test";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { DefaultExecutor, getExecutor } = await import("../../open-sse/executors/index.ts");
const { PROVIDER_ENDPOINTS } = await import("../../src/shared/constants/config.ts");
const { isValidModel } = await import("../../src/shared/constants/models.ts");
const { AGGREGATOR_PROVIDER_IDS } = await import("../../src/shared/constants/providers.ts");
const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers/apikey/index.ts");

const providers = [
  ["poolside", "poolside", "https://inference.poolside.ai/v1/chat/completions"],
] as const;

for (const [id, alias, endpoint] of providers) {
  test(`${id} is wired through registry, metadata, endpoint and default executor`, async () => {
    const registry = REGISTRY[id];
    const metadata = APIKEY_PROVIDERS[id];

    assert.ok(registry);
    assert.ok(metadata);
    assert.equal(registry.id, id);
    assert.equal(registry.alias, alias);
    assert.equal(registry.baseUrl, endpoint);
    assert.equal(PROVIDER_ENDPOINTS[id], endpoint);
    assert.equal(metadata.id, id);
    assert.equal(metadata.alias, alias);
    assert.equal(metadata.hasFree, true);
    assert.equal(metadata.passthroughModels, true);
    assert.ok(typeof metadata.freeNote === "string" && metadata.freeNote.length > 0);
    assert.ok((await getExecutor(id)) instanceof DefaultExecutor);
    assert.equal(isValidModel(id, "future/live-catalog-model"), true);
    assert.equal(isValidModel(alias, "future/live-catalog-model"), true);
  });
}

test("direct Poolside is not classified as an aggregator", () => {
  assert.equal(AGGREGATOR_PROVIDER_IDS.has("poolside"), false);
});
