// Kagi Assistant (web-cookie) was removed from this fork; only Kagi Search is covered here.
import test from "node:test";
import assert from "node:assert/strict";

import { SEARCH_PROVIDERS } from "../../open-sse/config/searchRegistry.ts";

test("Kagi Search uses the official v1 endpoint with a Bearer key", () => {
  const config = SEARCH_PROVIDERS["kagi-search"];
  assert.equal(config.costPerQuery, 0.012);
  assert.equal(config.baseUrl, "https://kagi.com/api/v1/search");
  assert.equal(config.authHeader, "bearer");
  assert.equal(config.method, "POST");
});

test("Kagi Search sends the official request and normalizes web results", async () => {
  const { handleSearch } = await import("../../open-sse/handlers/search.ts");
  const original = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(String(url), "https://kagi.com/api/v1/search");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-kagi-key");
    requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Response.json({
      data: {
        search: [{ title: "Kagi docs", url: "https://kagi.com/api/docs", snippet: "Search API" }],
      },
    });
  }) as typeof fetch;
  try {
    const result = await handleSearch({
      query: "Kagi API",
      provider: "kagi-search",
      maxResults: 3,
      searchType: "web",
      credentials: { apiKey: "test-kagi-key" },
      log: null,
    } as Parameters<typeof handleSearch>[0]);
    assert.equal(result.success, true);
    assert.deepEqual(requestBody, { query: "Kagi API", limit: 3 });
    assert.equal(result.data?.results?.[0]?.title, "Kagi docs");
    assert.equal(result.data?.usage?.search_cost_usd, 0.012);
  } finally {
    globalThis.fetch = original;
  }
});

test.after(async () => {
  const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
  await waitForCallLogSaves(3000);
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});
