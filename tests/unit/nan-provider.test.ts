// NaN.Builders (https://nan.builders) — OpenAI-compatible API-key provider covering
// chat, embeddings, STT, TTS, image generation and rerank, plus a per-model token
// quota fetcher (GET https://cloud-api.nan.builders/api/usage/quota).
import test from "node:test";
import assert from "node:assert/strict";

const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
const { PROVIDER_ENDPOINTS } = await import("../../src/shared/constants/config.ts");
const { REGISTRY: providerRegistry } = await import("../../open-sse/config/providerRegistry.ts");
const {
  getEmbeddingProvider: _getEmbeddingProvider,
  getEmbeddingDimension: _getEmbeddingDimension,
} = await import("../../open-sse/config/embeddingRegistry.ts");
const { getRerankProvider: _getRerankProvider } =
  await import("../../open-sse/config/rerankRegistry.ts");
const { isNamedOpenAIStyleProvider } =
  await import("../../src/app/api/providers/[id]/models/discovery/providerSets.ts");
const { USAGE_FETCHER_PROVIDERS } =
  await import("../../open-sse/services/usage/fetcherProviders.ts");
const { USAGE_SUPPORTED_PROVIDERS } =
  await import("../../open-sse/services/usage/supportedProviders.ts");
const N = await import("../../open-sse/services/usage/nan.ts");

const NAN_API = "https://api.nan.builders/v1";

test("nan is registered as an API-key provider in the UI catalog", () => {
  const entry = APIKEY_PROVIDERS.nan;
  assert.ok(entry, "APIKEY_PROVIDERS.nan must be defined");
  assert.equal(entry.id, "nan");
  assert.equal(entry.alias, "nan");
  assert.equal(entry.name, "NaN.Builders");
  assert.equal(entry.website, "https://nan.builders");
  assert.equal(entry.color, "#6D5EF3");
  for (const kind of ["llm", "embedding"]) {
    assert.ok(entry.serviceKinds.includes(kind), `serviceKinds must include ${kind}`);
  }
  assert.equal(
    entry.apiHint,
    "Create an API key at https://cloud.nan.builders, then paste it here as a Bearer token. " +
      "OpenAI-compatible base URL: https://api.nan.builders/v1."
  );
});

test("nan chat registry entry is OpenAI-compatible with live model discovery", () => {
  const entry = providerRegistry.nan;
  assert.ok(entry, "providerRegistry.nan must be defined");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "default");
  assert.equal(entry.authType, "apikey");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.baseUrl, `${NAN_API}/chat/completions`);
  assert.equal(entry.modelsUrl, `${NAN_API}/models`);
  assert.equal(PROVIDER_ENDPOINTS.nan, `${NAN_API}/chat/completions`);
  const ids = entry.models.map((m: { id: string }) => m.id);
  assert.ok(ids.includes("deepseek-v4-flash"));
  assert.equal(new Set(ids).size, ids.length, "seed ids must be unique");
  assert.equal(isNamedOpenAIStyleProvider("nan"), true);
});

test("nan usage fetcher is wired into both provider lists", () => {
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("nan"));
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("nan"));
});

test("formatNanUsage maps per-model counters to token quotas", () => {
  const result = N.formatNanUsage({
    models: [
      { model: "glm5.3", tokensUsed: 2500, cap: 10000, periodEnd: "2026-11-01T00:00:00Z" },
      { model: "qwen3.6", tokensUsed: 0, cap: 5000, periodEnd: null },
    ],
  });
  assert.equal(result.plan, "NaN.Builders");
  assert.ok(result.quotas, "quotas must be present");
  assert.deepEqual(result.quotas["glm5.3"], {
    used: 2500,
    total: 10000,
    remaining: 7500,
    remainingPercentage: 75,
    resetAt: "2026-11-01T00:00:00.000Z",
    unlimited: false,
    displayName: "glm5.3 (tokens)",
  });
  assert.equal(result.quotas["qwen3.6"].resetAt, null);
  assert.equal(result.quotas["qwen3.6"].remaining, 5000);
});

test("formatNanUsage rejects malformed counters instead of guessing", () => {
  const ok = { model: "glm5.3", tokensUsed: 1, cap: 10, periodEnd: "2026-11-01T00:00:00Z" };
  const bad: unknown[] = [
    null,
    {},
    { models: [] },
    { models: "x" },
    { models: [ok, { ...ok }] },
    { models: [{ ...ok, model: "  " }] },
    { models: [{ ...ok, tokensUsed: -1 }] },
    { models: [{ ...ok, tokensUsed: 1.5 }] },
    { models: [{ ...ok, cap: 0 }] },
    { models: [{ ...ok, cap: "10" }] },
    { models: [{ ...ok, periodEnd: "not-a-date" }] },
    { models: [{ ...ok, periodEnd: 123 }] },
  ];
  for (const report of bad) {
    const result = N.formatNanUsage(report);
    assert.equal(result.quotas, undefined, `must not produce quotas for ${JSON.stringify(report)}`);
    assert.match(result.message ?? "", /NaN\.Builders quota unavailable/);
  }
});

test("getNanUsage returns a friendly message when the api key is missing", async () => {
  const result = await N.getNanUsage("");
  assert.match(result.message ?? "", /NaN\.Builders API key not available/);
});

test("getNanUsage calls the quota endpoint with the bearer key", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({ models: [{ model: "glm5.3", tokensUsed: 10, cap: 100, periodEnd: null }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const result = await N.getNanUsage("nan-key");
    assert.equal(seenUrl, "https://cloud-api.nan.builders/api/usage/quota");
    assert.equal(seenAuth, "Bearer nan-key");
    assert.equal(result.quotas?.["glm5.3"].used, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getNanUsage surfaces HTTP status without echoing the upstream body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("secret upstream detail at /srv/app.js:1", { status: 401 });
  try {
    const result = await N.getNanUsage("k");
    assert.match(result.message ?? "", /Invalid NaN\.Builders API key/);
    assert.ok(!(result.message ?? "").includes("secret upstream detail"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response("boom", { status: 503 });
  try {
    const result = await N.getNanUsage("k");
    assert.match(result.message ?? "", /NaN\.Builders quota API error \(503\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getNanUsage sanitizes network errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED\n    at /srv/app/node_modules/undici/index.js:1:1");
  };
  try {
    const result = await N.getNanUsage("k");
    assert.match(result.message ?? "", /Unable to fetch usage/);
    assert.ok(!(result.message ?? "").includes("at /"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
