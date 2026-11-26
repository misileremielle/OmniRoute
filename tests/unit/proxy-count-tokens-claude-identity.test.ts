/**
 * `count_tokens` goes through the same SDK client as `/v1/messages` in the real
 * CLI, so it carries the same identity surface: session, class headers, the
 * billing block (signed, not a literal `cch=00000`), the same header casing and
 * order. It used to be built from the bare header map, which made the proxy look
 * like two different clients depending on the endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getExecutor } from "../../open-sse/executors/index.ts";
import { CLAUDE_CODE_CLIENT_VERSION } from "../../src/shared/constants/claudeCodeClient.ts";

type Captured = { headers: Record<string, string>; body: string; url: string };

async function captureCountTokens(credentials: Record<string, unknown>): Promise<Captured[]> {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify({ input_tokens: 7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const executor = await getExecutor("claude");
    await executor.countTokens({
      model: "claude-sonnet-4-6",
      body: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
      credentials: credentials as never,
    });
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

const OAUTH = {
  accessToken: "sk-ant-oat01-token",
  connectionId: "conn-count",
  providerSpecificData: {},
};

test("count_tokens carries the cloaked session and class headers", async () => {
  const [request] = await captureCountTokens(OAUTH);
  assert.ok(request, "the request must be sent");
  assert.match(request.headers["X-Claude-Code-Session-Id"], /^[0-9a-f-]{36}$/);
  assert.equal(request.headers["x-claude-code-request-class"], "main");
  assert.equal(request.headers["x-app"], "cli");
  assert.match(request.headers["User-Agent"], /^claude-cli\//);
});

test("count_tokens sends the billing block with a signed cch", async () => {
  const [request] = await captureCountTokens(OAUTH);
  const body = JSON.parse(request.body) as { system?: { text?: string }[] };
  const billing = body.system?.[0]?.text ?? "";
  assert.match(
    billing,
    new RegExp(`^x-anthropic-billing-header: cc_version=${CLAUDE_CODE_CLIENT_VERSION}\\.`)
  );
  assert.match(billing, /; cch=[0-9a-f]{5};$/);
  assert.doesNotMatch(billing, /cch=00000/);
});

test("count_tokens headers come out in the client's order", async () => {
  const [request] = await captureCountTokens(OAUTH);
  const keys = Object.keys(request.headers).map((key) => key.toLowerCase());
  const at = (name: string) => keys.indexOf(name);
  assert.equal(at("accept"), 0);
  assert.ok(at("x-stainless-os") > 0);
  assert.ok(at("x-claude-code-session-id") > at("x-stainless-os"));
  assert.ok(at("content-type") > at("x-claude-code-session-id"));
});

test("an api-key connection keeps the plain count_tokens shape", async () => {
  const [request] = await captureCountTokens({
    apiKey: "sk-ant-api03-x",
    connectionId: "conn-count-key",
    providerSpecificData: {},
  });
  assert.equal(request.headers["X-Claude-Code-Session-Id"], undefined);
  const body = JSON.parse(request.body) as { system?: unknown };
  assert.equal(body.system, undefined);
});
