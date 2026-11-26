/**
 * A Claude-compatible upstream sees `X-Claude-Code-Session-Id`. The real CLI
 * keeps one session for a conversation, so minting a fresh UUID per request
 * made every single turn look like a new CLI session on the wire.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GlmExecutor } from "../../open-sse/executors/glm.ts";

const anthropicCreds = (connectionId: string) => ({
  apiKey: "glm-key",
  connectionId,
  providerSpecificData: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    primaryTransport: "anthropic",
  },
});

test("the session header is stable across turns of one connection", () => {
  const executor = new GlmExecutor("glm");
  const first = executor.buildHeaders(anthropicCreds("conn-a"), true);
  const second = executor.buildHeaders(anthropicCreds("conn-a"), true);
  assert.ok(first["X-Claude-Code-Session-Id"]);
  assert.equal(second["X-Claude-Code-Session-Id"], first["X-Claude-Code-Session-Id"]);
});

test("distinct connections carry distinct sessions", () => {
  const executor = new GlmExecutor("glm");
  const a = executor.buildHeaders(anthropicCreds("conn-b"), true);
  const b = executor.buildHeaders(anthropicCreds("conn-c"), true);
  assert.notEqual(a["X-Claude-Code-Session-Id"], b["X-Claude-Code-Session-Id"]);
});

test("the request id stays per request", () => {
  const executor = new GlmExecutor("glm");
  const first = executor.buildHeaders(anthropicCreds("conn-d"), true);
  const second = executor.buildHeaders(anthropicCreds("conn-d"), true);
  assert.notEqual(first["x-client-request-id"], second["x-client-request-id"]);
});
