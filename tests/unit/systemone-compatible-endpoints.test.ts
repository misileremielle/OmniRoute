/**
 * System One (Jev) compatible endpoints.
 *
 * 1. Operator-added `systemone-compatible-*` provider nodes: created through
 *    POST /api/provider-nodes (initial base URL: OpenRouter's System One API) and
 *    addressed on POST /v1/systemone as `<prefix>/<model>`.
 * 2. /v1/systemone as a drop-in TypeSafe endpoint for other programs: the TypeSafe
 *    SDK sends zstd-compressed bodies (>= 1 KiB, Node >= 22.15), multipart bodies for
 *    image assets, extra request fields, and lists models via GET /v1/models
 *    expecting `{ models: [...] }`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-systemone-compatible-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "systemone-compatible-test-secret";
useDecollidedMigrationsDir();

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const providerNodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const systemOneRoute = await import("../../src/app/api/v1/systemone/route.ts");
const modelsRoute = await import("../../src/app/api/v1/models/route.ts");
const registry = await import("../../open-sse/config/systemOneRegistry.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const UPSTREAM_ANSWER = {
  id: "dec-1",
  model: "typesafe/jev-1.14",
  provider: "TypeSafe",
  answers: { billing: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 12, output_tokens: 1, cost: 0.00001 },
};

type Captured = { url: string; headers: Headers; body: Uint8Array };

function stubUpstream() {
  const originalFetch = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const body = init.body
      ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      : new Uint8Array();
    calls.push({ url: String(url), headers: new Headers(init.headers), body });
    return new Response(JSON.stringify(UPSTREAM_ANSWER), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-typesafe-request-id": "req_abc123" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

// ─── registry (pure) ───────────────────────────────────────────────────────

test("System One base URLs normalize to the server root the SDK appends /v1/systemone to", () => {
  for (const input of [
    "https://openrouter.ai/api",
    "https://openrouter.ai/api/",
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1/systemone",
  ]) {
    assert.equal(registry.sanitizeSystemOneBaseUrl(input), "https://openrouter.ai/api");
  }
  assert.equal(
    registry.systemOneEndpointUrl("https://api.typesafe.ai/v1"),
    "https://api.typesafe.ai/v1/systemone"
  );
});

test("custom nodes resolve <prefix>/<model>; OpenRouter gets its documented Jev ids", () => {
  const nodes = [
    {
      id: "systemone-compatible-or",
      prefix: "sys1",
      baseUrl: "https://openrouter.ai/api",
      type: "systemone-compatible",
    },
    {
      id: "systemone-compatible-self",
      prefix: "jevlab",
      baseUrl: "https://jev.example.com",
      type: "systemone-compatible",
    },
  ];
  const latest = registry.resolveSystemOneTarget("sys1/jev-latest", nodes)!;
  assert.equal(latest.provider, "systemone-compatible-or");
  assert.equal(latest.upstreamUrl, "https://openrouter.ai/api/v1/systemone");
  assert.equal(latest.upstreamModel, "~typesafe/jev-latest");
  assert.equal(
    registry.resolveSystemOneTarget("sys1/jev-1.13", nodes)!.upstreamModel,
    "typesafe/jev-1.13"
  );
  assert.equal(
    registry.resolveSystemOneTarget("sys1/inception/mercury-decide:free", nodes)!.upstreamModel,
    "inception/mercury-decide:free"
  );
  // Other servers get the model verbatim; the bare prefix means the server default.
  const self = registry.resolveSystemOneTarget("jevlab", nodes)!;
  assert.equal(self.upstreamUrl, "https://jev.example.com/v1/systemone");
  assert.equal(self.upstreamModel, "jev-latest");
  // Built-in routing is unchanged.
  assert.equal(registry.resolveSystemOneTarget("jev-latest", nodes)!.backend, "typesafe");
  assert.equal(registry.resolveSystemOneTarget("gpt-4o", nodes), null);
});

// ─── node creation ─────────────────────────────────────────────────────────

let nodeId = "";
let apiKey = "";

test("POST /api/provider-nodes creates a System One node with OpenRouter as the initial endpoint", async () => {
  const response = await providerNodesRoute.POST(
    new Request("http://localhost/api/provider-nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "OpenRouter System One",
        prefix: "sys1",
        type: "systemone-compatible",
      }),
    })
  );
  assert.equal(response.status, 201, await response.clone().text());
  const { node } = (await response.json()) as { node: Record<string, unknown> };
  assert.match(String(node.id), /^systemone-compatible-/);
  assert.equal(node.type, "systemone-compatible");
  assert.equal(node.baseUrl, "https://openrouter.ai/api");
  nodeId = String(node.id);

  await providersDb.createProviderConnection({
    provider: nodeId,
    authType: "apikey",
    name: "or-key",
    apiKey: "sk-or-v1-test",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  invalidateDbCache();
  apiKey = (await apiKeysDb.createApiKey("systemone-sdk", "machine-systemone", [])).key;
  apiKeysDb.clearApiKeyCaches();
});

// ─── /v1/systemone as a TypeSafe-compatible endpoint ───────────────────────

function sdkHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "typesafe-sdk/0.7.0",
    "X-TypeSafe-SDK": "typesafe-sdk/0.7.0",
    ...extra,
  };
}

test("a zstd-compressed SDK request is decoded, routed to the node and fully forwarded", async () => {
  const payload = {
    model: "sys1/jev-latest",
    state: "I was charged twice. Please help. ".repeat(60), // > 1 KiB like real SDK bodies
    questions: { billing: { type: "noul", instructions: "Is this about billing?" } },
    session_id: "sess-42",
  };
  const upstream = stubUpstream();
  try {
    const response = await systemOneRoute.POST(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: sdkHeaders({ "Content-Type": "application/json", "Content-Encoding": "zstd" }),
        body: zlib.zstdCompressSync(Buffer.from(JSON.stringify(payload))),
      })
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-typesafe-request-id"), "req_abc123");
    assert.deepEqual(
      ((await response.json()) as typeof UPSTREAM_ANSWER).answers,
      UPSTREAM_ANSWER.answers
    );

    assert.equal(upstream.calls.length, 1);
    const [call] = upstream.calls;
    assert.equal(call.url, "https://openrouter.ai/api/v1/systemone");
    assert.equal(call.headers.get("authorization"), "Bearer sk-or-v1-test");
    const sent = JSON.parse(new TextDecoder().decode(call.body));
    assert.equal(sent.model, "~typesafe/jev-latest");
    assert.equal(sent.session_id, "sess-42", "extra request fields are forwarded");
    assert.equal(sent.state, payload.state);
  } finally {
    upstream.restore();
  }
});

test("a multipart SDK request keeps its image parts byte-for-byte", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const requestJson = {
    model: "sys1/jev-1.13",
    state: "<photo>",
    questions: { cat: { type: "noul", instructions: "Is there a cat?" } },
    assets: { "<photo>": { type: "image", part: "asset-0" } },
  };
  const boundary = "testboundary123";
  const body = new Blob([
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`,
    JSON.stringify(requestJson),
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="asset-0"; filename="asset-0"\r\nContent-Type: image/png\r\n\r\n`,
    png,
    `\r\n--${boundary}--\r\n`,
  ]);
  const upstream = stubUpstream();
  try {
    const response = await systemOneRoute.POST(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: sdkHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
        body,
      })
    );
    assert.equal(response.status, 200, await response.clone().text());
    const [call] = upstream.calls;
    const contentType = call.headers.get("content-type") || "";
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    const form = await new Response(call.body, {
      headers: { "content-type": contentType },
    }).formData();
    const forwarded = JSON.parse(String(form.get("request")));
    assert.equal(forwarded.model, "typesafe/jev-1.13");
    assert.deepEqual(forwarded.assets, requestJson.assets);
    const image = form.get("asset-0") as File;
    assert.equal(image.type, "image/png");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  } finally {
    upstream.restore();
  }
});

test("undecodable or unsupported bodies are rejected without an upstream call", async () => {
  const upstream = stubUpstream();
  try {
    const badZstd = await systemOneRoute.POST(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: sdkHeaders({ "Content-Type": "application/json", "Content-Encoding": "zstd" }),
        body: "not zstd",
      })
    );
    assert.equal(badZstd.status, 400);
    const unknown = await systemOneRoute.POST(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: sdkHeaders({ "Content-Type": "application/json", "Content-Encoding": "lz4" }),
        body: "{}",
      })
    );
    assert.equal(unknown.status, 415);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test("GET /v1/models answers the TypeSafe SDK in its { models: [...] } shape", async () => {
  const response = await modelsRoute.GET(
    new Request("http://localhost/v1/models", { headers: sdkHeaders() })
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { models?: unknown[]; data?: unknown };
  assert.ok(Array.isArray(payload.models), "SDK requires a models array");
  assert.equal(payload.data, undefined);
});
