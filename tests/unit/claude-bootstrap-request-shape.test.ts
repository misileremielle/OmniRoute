/**
 * The CLI's bootstrap call is *not* the messages call and must not borrow its
 * identity. Native `claude_cli/bootstrap`:
 *
 *   headers: { "Content-Type": "application/json", "User-Agent": `claude-code/${ccVersion}` }
 *   ...auth headers (Authorization: Bearer + anthropic-beta: oauth-2025-04-20, from the oat branch)
 *   params:  { entrypoint, model }
 *
 * Verified in the published 2.1.332 binary (`_e` builds the UA/params, `_Vn` adds
 * only user custom headers). Sending the messages UA (`claude-cli/… (external, cli)`)
 * and no query at all is a shape no real client produces.
 */
import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const body = {
  oauth_account: { account_uuid: "00000000-0000-4000-8000-00000000000a", seat_tier: "team" },
};

async function capture(token = "unit-token", options?: { model?: string }) {
  const captured: { url: string; headers: Headers } = { url: "", headers: new Headers() };
  globalThis.fetch = (async (input, init) => {
    captured.url = String(input);
    captured.headers = new Headers(init?.headers);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const { fetchClaudeBootstrap } = await import("../../open-sse/executors/claudeIdentity.ts");
  const { getClaudeCodeVersion } = await import("../../open-sse/executors/claudeIdentity.ts");
  const result = await fetchClaudeBootstrap(token, options);
  return { captured, result, version: getClaudeCodeVersion() };
}

test("bootstrap uses the claude-code user agent, not the messages one", async () => {
  const { captured, version } = await capture();
  assert.equal(captured.headers.get("user-agent"), `claude-code/${version}`);
});

test("bootstrap sends the same auth shape as the CLI's oat branch", async () => {
  const { captured } = await capture();
  assert.equal(captured.headers.get("authorization"), "Bearer unit-token");
  assert.equal(captured.headers.get("anthropic-beta"), "oauth-2025-04-20");
});

test("bootstrap carries the entrypoint query param", async () => {
  const { captured } = await capture();
  const url = new URL(captured.url);
  assert.equal(url.pathname, "/api/claude_cli/bootstrap");
  assert.equal(url.searchParams.get("entrypoint"), "cli");
});

test("bootstrap forwards the model when the caller knows one", async () => {
  const { captured } = await capture("unit-token", { model: "claude-sonnet-4-5" });
  assert.equal(new URL(captured.url).searchParams.get("model"), "claude-sonnet-4-5");
});

test("bootstrap still parses the account when the caller passes no model", async () => {
  const { captured, result } = await capture();
  assert.equal(new URL(captured.url).searchParams.has("model"), false);
  assert.equal(result?.account_uuid, "00000000-0000-4000-8000-00000000000a");
});
