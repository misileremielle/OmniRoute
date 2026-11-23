import assert from "node:assert/strict";
import test from "node:test";
import { unexpectedCatalogNetworkRequests } from "./catalogNetworkGuard13389.ts";

// Import this helper dynamically after selecting the test's DATA_DIR, before
// application modules. Catalog content regressions do not need anonymous image
// discovery over the internet. Keep the real catalog timeout and cache behavior.
const guardedFetch = globalThis.fetch;
// Install the proxy fetch interceptor now, so the override below is the last word. Upstream
// got this as a side effect of importing its image catalog, which the fork removed; without
// it the interceptor installs later and its undici dispatcher reaches chatgpt.com directly.
await import("../../open-sse/utils/proxyFetch.ts");

// Importing the proxy fetch module installs the interceptor. Restore
// a controlled boundary after that side effect. These listing tests treat the
// optional Codex quota reading as unavailable; every other unmocked URL still fails.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url === "https://chatgpt.com/backend-api/wham/usage" && method === "GET") {
    return Response.json({ error: "quota unavailable in catalog fixture" }, { status: 503 });
  }
  return guardedFetch(input, init);
};

test.after(() => {
  assert.deepEqual(
    unexpectedCatalogNetworkRequests,
    [],
    "catalog fixtures must not use live network"
  );
});
