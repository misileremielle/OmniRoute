/**
 * End-to-end guard for the synthesized Claude Code identity: two requests on the
 * same connection with DIFFERENT access tokens (i.e. across a token refresh)
 * must carry the same session id. The seed used to be the access token, so a
 * refresh produced a new session — and a new account_uuid — mid-conversation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getExecutor } from "../../open-sse/executors/index.ts";
import { computeFingerprint } from "../../open-sse/services/claudeCodeFingerprint.ts";
import { CLAUDE_CODE_CLIENT_VERSION } from "../../src/shared/constants/claudeCodeClient.ts";

const BODY = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 16,
};

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "claude-sonnet-4-6",
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function headerOf(headers: unknown, name: string): string | undefined {
  const record = headers as Record<string, string> | undefined;
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function billingOf(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const system = JSON.parse(body)?.system;
    return Array.isArray(system) && typeof system[0]?.text === "string"
      ? system[0].text
      : undefined;
  } catch {
    return undefined;
  }
}

function accountUuidOf(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const userId = JSON.parse(body)?.metadata?.user_id;
    if (typeof userId !== "string") return undefined;
    const parsed = JSON.parse(userId) as { account_uuid?: unknown };
    return typeof parsed.account_uuid === "string" ? parsed.account_uuid : undefined;
  } catch {
    return undefined;
  }
}

async function captureIdentityHeaders(
  accessToken: string,
  connectionId: string,
  clientHeaders?: Record<string, string>
) {
  const captured: {
    session?: string;
    account?: string;
    billing?: string;
    requestClass?: string;
    onePClass?: string;
    order?: string[];
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    captured.push({
      session: headerOf(init?.headers, "x-claude-code-session-id"),
      account: accountUuidOf(init?.body),
      billing: billingOf(init?.body),
      requestClass: headerOf(init?.headers, "x-claude-code-request-class"),
      onePClass: headerOf(init?.headers, "x-claude-1p-request-class"),
      order: Object.keys((init?.headers ?? {}) as Record<string, string>),
    });
    return new Response(JSON.stringify(MESSAGE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const executor = await getExecutor("claude");
    await executor.execute({
      model: "claude-sonnet-4-6",
      body: BODY,
      stream: false,
      credentials: {
        accessToken,
        connectionId,
        providerSpecificData: {},
      } as never,
      clientHeaders,
    });
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

test("a token refresh does not change the synthesized session id", async () => {
  const connectionId = `conn-session-${Date.now()}`;
  const first = await captureIdentityHeaders("sk-ant-oat01-first", connectionId);
  const second = await captureIdentityHeaders("sk-ant-oat01-second", connectionId);

  const firstSession = first.find((entry) => entry.session)?.session;
  const secondSession = second.find((entry) => entry.session)?.session;
  assert.ok(firstSession, "the first request must carry a session id");
  assert.equal(secondSession, firstSession);

  const firstAccount = first.find((entry) => entry.account)?.account;
  const secondAccount = second.find((entry) => entry.account)?.account;
  assert.ok(firstAccount, "the first request must carry a synthesized account uuid");
  assert.equal(secondAccount, firstAccount);
});

test("a different connection is still a different identity", async () => {
  const first = await captureIdentityHeaders("sk-ant-oat01-a", `conn-a-${Date.now()}`);
  const second = await captureIdentityHeaders("sk-ant-oat01-b", `conn-b-${Date.now()}`);
  assert.notEqual(
    first.find((entry) => entry.session)?.session,
    second.find((entry) => entry.session)?.session
  );
});

test("a client's own conversation session id is used verbatim", async () => {
  const clientSession = "0f0f0f0f-1111-4222-8333-444455556666";
  const captured = await captureIdentityHeaders("sk-ant-oat01-token", `conn-${Date.now()}`, {
    "x-claude-code-session-id": clientSession,
  });
  assert.equal(captured.find((entry) => entry.session)?.session, clientSession);
});

test("cc_version carries the per-message fingerprint, not a static suffix", async () => {
  const connectionId = `conn-billing-${Date.now()}`;
  const captured = await captureIdentityHeaders("sk-ant-oat01-token", connectionId);
  const billing = captured.find((entry) => entry.billing)?.billing;
  assert.ok(billing, "the billing header must be sent");
  // Literal, independent of computeFingerprint: "hi" has no chars at 4/7/20, so the
  // picks are "000" and sha256("59cf53e54c78" + "000" + "2.1.332") starts 18b.
  // Algorithm read out of the published 2.1.332 binary (L6i/XLl).
  assert.match(billing, new RegExp(`cc_version=${CLAUDE_CODE_CLIENT_VERSION}\\.18b;`));
  assert.equal(computeFingerprint("hi", CLAUDE_CODE_CLIENT_VERSION), "18b");
});

test("the claude cloak sends the request-class pair the CLI sends", async () => {
  const captured = await captureIdentityHeaders("sk-ant-oat01-token", `conn-class-${Date.now()}`);
  const first = captured.find((entry) => entry.session);
  assert.equal(first?.requestClass, "main");
  assert.equal(first?.onePClass, "main");
});

test("the identity headers follow the SDK merge order", async () => {
  // The SDK folds the CLI's defaultHeaders in after its own base headers, so the
  // session and class headers belong after the Stainless block — not first.
  const captured = await captureIdentityHeaders("sk-ant-oat01-token", `conn-order-${Date.now()}`);
  // The messages call is the one carrying the identity block; earlier fetches on
  // this path (bootstrap) use a different header set.
  const order = captured.find((entry) => entry.session)?.order ?? [];
  const at = (name: string) => order.findIndex((key) => key.toLowerCase() === name);

  assert.ok(at("user-agent") >= 0 && at("user-agent") <= 2, "User-Agent stays in the base block");
  assert.ok(at("x-stainless-os") > 0, `no stainless block: ${order.join("|")}`);
  assert.ok(at("x-claude-code-session-id") > at("x-stainless-os"), order.join("|"));
  assert.ok(at("x-claude-code-request-class") > at("x-claude-code-session-id"));
  assert.ok(at("content-type") > at("x-claude-code-request-class"));
});
