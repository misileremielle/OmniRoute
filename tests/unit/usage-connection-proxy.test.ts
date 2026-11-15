/**
 * usage-connection-proxy.test.ts — usage readers run through the connection proxy.
 *
 * Guard: with a proxy assigned to the connection, the upstream usage request
 * runs inside the connection proxy context instead of a direct fetch;
 * failures surface as the existing message and never retry outside the proxy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectionProxyTestOverride,
  fetchWithConnectionProxy,
} from "../../open-sse/services/connectionProxyFetch.ts";

const ASSIGNED_PROXY = { type: "socks5", host: "127.0.0.1", port: 9 };
const BALANCE_BODY = JSON.stringify({
  dailyCredits: 10,
  subscriptionCredits: 20,
  subscriptionAmount: 100,
  extraCredits: 5,
  total: 35,
});
const originalFetch = globalThis.fetch;

function balanceResponse(): Response {
  return new Response(BALANCE_BODY, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function useAssignedProxy(): void {
  connectionProxyTestOverride.resolveProxyForConnection = async () => ({
    proxy: ASSIGNED_PROXY,
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  connectionProxyTestOverride.resolveProxyForConnection = null;
});

test("a reading without a connection identifier makes no fetch", async () => {
  useAssignedProxy();
  const { fetchWithConnectionProxy: proxiedFetch } =
    await import("../../open-sse/services/connectionProxyFetch.ts");
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return balanceResponse();
  }) as typeof globalThis.fetch;
  const response = await proxiedFetch("", "https://conol.ai/api/billing/balance", undefined, {
    resolveProxyForConnection: async () => ({ proxy: ASSIGNED_PROXY }),
    fetchFn,
  });
  assert.equal(response, null);
  assert.equal(calls, 0);
});

test("usage leaves route every proxied fetch through the connection proxy helper", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "open-sse", "services");
  const leaves = [
    join(root, "usage", "github.ts"),
    join(root, "usage", "claude.ts"),
    join(root, "usage", "codex.ts"),
    join(root, "usage", "cursor.ts"),
    join(root, "usage", "devinCli.ts"),
  ];
  for (const file of leaves) {
    const source = readFileSync(file, "utf8");
    // Only the module seam initializer (`... => fetch(...)`) and qualified
    // `globalThis.fetch` / `codexUsageFetch(...)` calls may remain.
    const scrubbed = source
      .replace(/=>\s*fetch\([^)]*\)/g, "")
      .replace(/codexUsageFetch\(/g, "")
      .replace(/globalThis\.fetch\(/g, "");
    assert.ok(
      !/(^|[^a-zA-Z_.])fetch\(/.test(scrubbed),
      `${file} must not call bare fetch directly`
    );
    assert.ok(
      source.includes("fetchWithConnectionProxy("),
      `${file} must route through the connection proxy helper`
    );
  }
});

test("the helper reports a missing identifier instead of fetching directly", async () => {
  let calls = 0;
  const fetchFn = (async (): Promise<Response> => {
    calls += 1;
    return balanceResponse();
  }) as typeof globalThis.fetch;
  const response = await fetchWithConnectionProxy(
    "",
    "https://console.example/api/balance",
    undefined,
    {
      resolveProxyForConnection: async () => ({ proxy: ASSIGNED_PROXY }),
      fetchFn,
    }
  );
  assert.equal(response, null);
  assert.equal(calls, 0);
});
