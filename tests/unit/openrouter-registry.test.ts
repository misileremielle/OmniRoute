import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getEmbeddingProvider,
  parseEmbeddingModel,
  getAllEmbeddingModels,
} from "../../open-sse/config/embeddingRegistry.ts";

describe("OpenRouter registry entries (#960)", () => {
  // ── Embedding Registry ──────────────────────────────────────────────────

  describe("embeddingRegistry — openrouter", () => {
    it("resolves openrouter provider config", () => {
      const p = getEmbeddingProvider("openrouter");
      assert.ok(p, "openrouter should be in EMBEDDING_PROVIDERS");
      assert.equal(p.baseUrl, "https://openrouter.ai/api/v1/embeddings");
      assert.equal(p.authHeader, "bearer");
    });

    it("openrouter has at least 3 models", () => {
      const p = getEmbeddingProvider("openrouter");
      assert.ok(p.models.length >= 3, `Expected ≥3 models, got ${p.models.length}`);
    });

    it("parses openrouter/openai/text-embedding-3-small correctly", () => {
      const result = parseEmbeddingModel("openrouter/openai/text-embedding-3-small");
      assert.equal(result.provider, "openrouter");
      assert.equal(result.model, "openai/text-embedding-3-small");
    });

    it("openrouter models appear in getAllEmbeddingModels", () => {
      const all = getAllEmbeddingModels();
      const orModels = all.filter((m) => m.provider === "openrouter");
      assert.ok(orModels.length > 0, "Expected openrouter models in full list");
    });
  });

  // ── Image Registry ───────────────────────────────────────────────────────

  describe("imageRegistry — openrouter", () => {});
});
