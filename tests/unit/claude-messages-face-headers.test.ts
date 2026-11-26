/**
 * The Claude messages face — the header set, as bytes on the wire.
 *
 * Everything here was read out of the 2.1.332 binary (`buildHeaders`, `cd()`, the
 * Stainless defaults, the client's `dangerouslyAllowBrowser: true`). The point of a
 * set-level assertion is that both directions matter: a missing identity header and
 * an extra proxy header are the same kind of tell, and per-header tests miss the
 * second one.
 *
 * `x-client-request-id` is first-party only and fresh per attempt: the client gates it
 * on `hDe()` (provider is first-party) and takes the value from
 * `import{randomUUID as oLs}from"crypto"`. `traceparent` stays out — it needs
 * `CLAUDE_CODE_PROPAGATE_TRACEPARENT` plus an inbound trace, which a proxy does not have.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BaseExecutor } from "../../open-sse/executors/base.ts";
import { getClaudeCodeVersion } from "../../open-sse/executors/claudeIdentity.ts";

class RelayExecutor extends BaseExecutor {
  constructor() {
    super("claude", { baseUrls: ["https://face.example.test/v1/messages"] });
  }
  needsRefresh() {
    return false;
  }
}

const oauthToken = (tag: string) => ["sk", "ant", "oat" + tag].join("-");

const EXPECTED = [
  "accept",
  "accept-encoding",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "authorization",
  "connection",
  "content-type",
  "user-agent",
  "x-app",
  "x-claude-1p-request-class",
  "x-claude-code-request-class",
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
].sort();

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/**
 * Sends one request and returns the wire records. A cold token also fires the
 * bootstrap call first, so callers look at the last wire — the messages request.
 */
async function send(credentials: Record<string, unknown>, stream: boolean) {
  const original = globalThis.fetch;
  const wires: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    wires.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
    return new Response(stream ? SSE : JSON.stringify({ id: "msg_1", type: "message" }), {
      status: 200,
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    });
  }) as typeof fetch;
  try {
    await new RelayExecutor().execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
        stream,
      },
      stream,
      credentials: credentials as never,
    });
  } finally {
    globalThis.fetch = original;
  }
  return wires;
}

for (const stream of [true, false]) {
  test(`the ${stream ? "streaming" : "non-streaming"} send carries exactly the client's header set`, async () => {
    const wires = await send({ accessToken: oauthToken(`01-set${stream}`) }, stream);
    assert.ok(wires.length >= 1, "the request must have gone out");
    assert.deepEqual(Object.keys(wires.at(-1)!).sort(), EXPECTED);
  });
}

test("the request carries a fresh UUID correlation id on every attempt", async () => {
  const original = globalThis.fetch;
  const wires: Record<string, string>[] = [];
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    wires.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
    n += 1;
    // First messages attempt: the rejected field, so the executor retries.
    if (n === 2) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "verbosity: Extra inputs are not permitted",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await new RelayExecutor().execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
        verbosity: "low",
        stream: true,
      },
      stream: true,
      credentials: { accessToken: oauthToken("04-request-id") } as never,
    });
  } finally {
    globalThis.fetch = original;
  }
  const messages = wires.filter((w) => (w["user-agent"] ?? "").startsWith("claude-cli/"));
  assert.equal(messages.length, 2, "one send and one retry");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const wire of messages) {
    assert.match(wire["x-client-request-id"] ?? "", uuid, "a UUIDv4 correlation id");
  }
  assert.notEqual(
    messages[0]["x-client-request-id"],
    messages[1]["x-client-request-id"],
    "each attempt gets its own id"
  );
});

test("a background session keeps its own x-app instead of being relabelled", async () => {
  const original = globalThis.fetch;
  const wires: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    wires.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await new RelayExecutor().execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      stream: true,
      credentials: { accessToken: oauthToken("05-bg") } as never,
      clientHeaders: { "x-app": "cli-bg", "user-agent": "claude-cli/2.1.332 (external, cli)" },
    });
  } finally {
    globalThis.fetch = original;
  }
  const messages = wires.filter((w) => (w["user-agent"] ?? "").startsWith("claude-cli/"));
  assert.equal(messages.at(-1)?.["x-app"], "cli-bg", "a background turn stays background");
});

test("the cold bootstrap goes out as the API face, before the messages call", async () => {
  const wires = await send({ accessToken: oauthToken("03-boot") }, true);
  assert.ok(wires.length >= 2, "a cold token bootstraps before it sends");
  assert.equal(
    wires[0]["user-agent"],
    "claude-code/2.1.332".replace("2.1.332", getClaudeCodeVersion())
  );
  assert.equal(wires[0]["x-app"], undefined);
  assert.ok(!(wires[0]["user-agent"] ?? "").includes("(external"));
});

test("no proxy or OmniRoute header survives to the upstream", async () => {
  const wires = await send({ accessToken: oauthToken("02-proxy") }, true);
  const names = Object.keys(wires.at(-1)!).map((name) => name.toLowerCase());
  for (const leak of ["x-forwarded-for", "via", "forwarded", "x-real-ip", "host"]) {
    assert.equal(names.includes(leak), false, `${leak} must not reach the upstream`);
  }
  assert.equal(
    names.some((name) => name.startsWith("x-omniroute-")),
    false,
    "OmniRoute markers must not reach the upstream"
  );
});
