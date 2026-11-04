import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_PROVIDERS,
  getEmbeddingProvider,
} from "../../open-sse/config/embeddingRegistry.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";

describe("nanogpt endpoint surface (#9322)", () => {
  describe("audio transcription", () => {});

  describe("audio speech", () => {});

  describe("video generation", () => {});

  describe("embeddings", () => {
    it("is registered in EMBEDDING_PROVIDERS", () => {
      assert.ok(EMBEDDING_PROVIDERS.nanogpt, "nanogpt should be in EMBEDDING_PROVIDERS");
    });

    it("resolves nanogpt embedding config", () => {
      const p = getEmbeddingProvider("nanogpt");
      assert.ok(p, "getEmbeddingProvider should resolve nanogpt");
      assert.equal(p.id, "nanogpt");
      assert.equal(p.baseUrl, "https://nano-gpt.com/v1/embeddings");
      assert.equal(p.authType, "apikey");
      assert.equal(p.authHeader, "bearer");
    });

    it("has at least one embedding model", () => {
      const p = getEmbeddingProvider("nanogpt");
      assert.ok(p.models.length >= 1, "Expected >= 1 embedding model");
    });
  });

  describe("registry entry", () => {
    it("has a registry entry with the canonical identity", () => {
      const entry = REGISTRY.nanogpt;
      assert.ok(entry, "REGISTRY.nanogpt should be defined");
      assert.equal(entry.id, "nanogpt");
      assert.equal(entry.format, "openai");
      assert.equal(entry.executor, "default");
    });

    it("has responsesBaseUrl for Responses API", () => {
      const entry = REGISTRY.nanogpt;
      assert.ok(entry, "REGISTRY.nanogpt should be defined");
      assert.ok(entry.responsesBaseUrl, "nanogpt registry entry should have responsesBaseUrl");
      assert.equal(entry.responsesBaseUrl, "https://nano-gpt.com/api/v1/responses");
    });
  });
});
