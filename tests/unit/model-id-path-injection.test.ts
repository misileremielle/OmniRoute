// A model id is interpolated into the upstream URL path by many providers. The URL parser folds
// `%2e%2e` into a dot-segment and ends the path at `#`, so `gemini/%2e%2e/cachedContents#` used to
// make the executor POST to another endpoint of the provider with the operator's credential, and
// `gemini-2.5-flash/%2e%2e/gemini-3-pro` reached a different model while the string still matched
// an allow-list pattern such as `gemini/gemini-2.5-flash*`.
import test from "node:test";
import assert from "node:assert/strict";

const { hasUnsafeModelIdSyntax } = await import("../../open-sse/utils/modelIdSafety.ts");
const { parseModel } = await import("../../open-sse/services/model.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const _embedding = await import("../../open-sse/config/embeddingRegistry.ts");
const _rerank = await import("../../open-sse/config/rerankRegistry.ts");
const _ocr = await import("../../open-sse/config/ocrRegistry.ts");

const UNSAFE = [
  "%2e%2e/cachedContents#",
  ".%2e/.%2e/upload/v1beta/files?x=",
  "gemini-2.5-flash/%2e%2e/gemini-3-pro",
  "gemini-2.5-flash/%2E%2E/gemini-3-pro",
  "a/..%2fb",
  "a%2fb",
  "a%5cb",
  "model#fragment",
  "model?query=1",
  "a\\b",
  "a/./b",
  "a/../b",
  "a/..",
  "..",
  "model%23x",
  "model%3fx",
  "model%00",
];

const SAFE = [
  "gemini-2.5-flash",
  "models/gemini-2.5-flash",
  "@cf/meta/llama-3-8b-instruct",
  "org/model:tag",
  "gpt-4.1",
  "gpt-4o-mini",
  "claude-sonnet-4-6[1m]",
  "accounts/fireworks/models/llama-v3p1-70b-instruct",
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  "gemini-1.5-pro@002",
  "deepseek-r1.5",
  "publishers/google/models/gemini-2.5-pro",
];

test("hasUnsafeModelIdSyntax flags encoded dot-segments, separators, queries and fragments", () => {
  for (const id of UNSAFE) assert.equal(hasUnsafeModelIdSyntax(id), true, id);
});

test("hasUnsafeModelIdSyntax leaves ordinary model ids alone", () => {
  for (const id of SAFE) assert.equal(hasUnsafeModelIdSyntax(id), false, id);
});

test("parseModel refuses a prefixed or bare id that could rewrite the upstream path", () => {
  for (const id of UNSAFE) {
    for (const value of [`gemini/${id}`, `vertex/${id}`, `openai/${id}`, id]) {
      const parsed = parseModel(value);
      assert.equal(parsed.model, null, value);
      assert.equal(parsed.provider, null, value);
    }
  }
});

test("parseModel still parses ordinary ids", () => {
  for (const id of SAFE) {
    const parsed = parseModel(`gemini/${id}`);
    assert.equal(parsed.provider, "gemini", id);
    assert.equal(parsed.model, id.replace(/\[1m\]$/, ""), id);
  }
});

test("the Gemini upstream URL is only ever built for ids that keep it on the models path", () => {
  const executor = new (
    DefaultExecutor as unknown as new (provider: string) => {
      buildUrl: (...args: unknown[]) => string;
    }
  )("gemini");
  const upstream = (modelString: string): string | null => {
    const { model } = parseModel(modelString);
    if (!model) return null;
    return new URL(executor.buildUrl(model, true, 0, { apiKey: "k", providerSpecificData: {} }))
      .href;
  };

  assert.equal(
    upstream("gemini/gemini-2.5-flash"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
  );
  assert.equal(upstream("gemini/%2e%2e/cachedContents#"), null);
  assert.equal(upstream("gemini/.%2e/.%2e/upload/v1beta/files?x="), null);
  // Matches an allow-list pattern of `gemini/gemini-2.5-flash*` but would reach another model.
  assert.equal(upstream("gemini/gemini-2.5-flash/%2e%2e/gemini-3-pro"), null);
});
