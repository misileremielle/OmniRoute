/**
 * The Claude *API* face — every non-`/v1/messages` call OmniRoute makes on a
 * subscription's behalf (bootstrap, usage, reset list, reset claim).
 *
 * These are the easy ones to forget: they are scattered across services, they run
 * from schedulers, and the messages path's identity is wrong for them. The real
 * client answers all of them as `claude-code/<version>` (`Li()` in the binary, the
 * same string the bootstrap call builds) — never the `claude-cli/… (external, cli)`
 * Stainless client and never bare.
 *
 * A test per call site already exists; this file holds the one property they share
 * so a new call site cannot quietly invent a third identity. The Codex usage probe
 * is here for the same reason: an anonymous half-identity next to converged
 * inference traffic is its own tell.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getClaudeCodeVersion } from "../../open-sse/executors/claudeIdentity.ts";

const API_UA = `claude-code/${getClaudeCodeVersion()}`;
const originalFetch = globalThis.fetch;
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/omniroute-api-face-identity";

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
});

type Capture = { url: string; method: string; headers: Record<string, string> };

function stubFetch(json: unknown = {}): Capture[] {
  const calls: Capture[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function assertApiFace(headers: Record<string, string>, label: string): void {
  const ua = headers["User-Agent"] ?? "";
  assert.equal(ua, API_UA, `${label} must identify as the agent, not the messages client`);
  assert.doesNotMatch(ua, /\(external/, `${label} must not carry the messages UA suffix`);
  assert.equal(headers["x-app"], undefined, `${label} must not send the messages x-app marker`);
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20", `${label} keeps the oat beta`);
  assert.match(headers.Authorization ?? "", /^Bearer /, `${label} must authenticate`);
}

test("bootstrap answers as the agent", async () => {
  const { fetchClaudeBootstrap } = await import("../../open-sse/executors/claudeIdentity.ts");
  const calls = stubFetch({ oauth_account: { account_uuid: "a" } });
  await fetchClaudeBootstrap("tok");
  assertApiFace(calls[0].headers, "bootstrap");
});

test("the usage poller answers as the agent", async () => {
  const calls = stubFetch({ five_hour: {}, seven_day: {} });
  const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.ts");
  await getClaudeUsage("conn-api-face", "tok").catch(() => null);
  const call = calls.find((c) => c.url.includes("/api/oauth/usage"));
  assert.ok(call, "the usage poll must have run");
  assertApiFace(call.headers, "usage poll");
});

test("the reset-credit list answers as the agent", async () => {
  const calls = stubFetch({ juniper_tide: { eligible: false }, cedar_ember: { grants: [] } });
  const { fetchClaudeResetCreditUsage } =
    await import("../../open-sse/services/claudeResetCreditCount.ts");
  await fetchClaudeResetCreditUsage("tok").catch(() => null);
  const call = calls.find((c) => c.url.includes("cedar_ember=1"));
  assert.ok(call, "the reset-credit list must have run");
  assertApiFace(call.headers, "reset-credit list");
});

test("both claim profiles answer as the agent", async () => {
  const { claimClaudeResetCredit } = await import("../../open-sse/services/claudeLimitReset.ts");
  for (const profile of ["auto-reset", "dashboard"] as const) {
    const calls = stubFetch({ result: "reset" });
    await claimClaudeResetCredit("tok", "org-1", { profile, creditId: "c1" });
    const call = calls.find((c) => c.method === "POST");
    assert.ok(call, `the ${profile} claim must have run`);
    assertApiFace(call.headers, `${profile} claim`);
  }
});

// The same property on the Codex side: the usage probe must not appear as a
// half-identity next to the inference traffic (codex-rs `default_headers()` sends
// `originator` + `User-Agent`, nothing else).
test("the codex usage probe carries the same identity as inference", async () => {
  const calls = stubFetch({});
  const { getCodexUsage } = await import("../../open-sse/services/usage/codex.ts");
  await getCodexUsage("tok", { workspaceId: "ws-1" }).catch(() => null);
  assert.ok(calls.length >= 1, "the usage probe must have run");
  const headers = calls[0].headers;
  assert.match(headers["User-Agent"] ?? "", /^codex_cli_rs\/\d+\.\d+\.\d+ \(/);
  assert.equal(headers.originator, "codex_cli_rs");
  assert.match(headers.Authorization ?? "", /^Bearer /);
  assert.equal(headers["chatgpt-account-id"], "ws-1");
});

// Antigravity's two client profiles must stay distinct: the Go CLI and the Electron
// IDE differ in the UA, the SSE Accept, and the quota-project header, and neither may
// carry the other's markers.
test("antigravity profile identity survives the executor", async () => {
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const executor = new AntigravityExecutor({ id: "antigravity" });

  const build = (clientProfile: "cli" | "ide") =>
    executor.buildHeaders({
      accessToken: "tok",
      providerSpecificData: { clientProfile },
    } as never);

  const cli = build("cli");
  assert.match(
    cli["User-Agent"],
    /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=[a-z]+; arch=[a-z0-9]+; cl=\d+; auth_method=consumer\)$/
  );
  assert.equal(cli["X-Goog-Api-Client"], undefined, "the CLI sends no X-Goog-Api-Client");
  assert.equal(cli["Client-Metadata"], undefined, "the CLI sends no Client-Metadata");
  assert.equal(cli.Accept, undefined, "the CLI asks for SSE with ?alt=sse alone");
  assert.equal(cli["Accept-Encoding"], "gzip, deflate, br");

  const ide = build("ide");
  assert.match(ide["User-Agent"], /^antigravity\/ide\/\d+\.\d+\.\d+ [^/]+\/[^\s]+$/);
  assert.equal(ide.Accept, "text/event-stream");
});

test("antigravity scrubs proxy and Stainless headers from both profiles", async () => {
  const { scrubProxyAndFingerprintHeaders } =
    await import("../../open-sse/services/antigravityHeaderScrub.ts");
  const scrubbed = scrubProxyAndFingerprintHeaders({
    "User-Agent":
      "antigravity/cli/1.5.17 (aidev_client; os_type=linux; arch=amd64; cl=1; auth_method=consumer)",
    "x-forwarded-for": "10.0.0.1",
    via: "1.1 proxy",
    "x-stainless-lang": "js",
    "sec-ch-ua": '"Chromium"',
    Authorization: "Bearer tok",
    "Accept-Encoding": "gzip, deflate, br, zstd",
  });
  for (const gone of ["x-forwarded-for", "via", "x-stainless-lang", "sec-ch-ua"]) {
    assert.equal(scrubbed[gone], undefined, `${gone} must be scrubbed`);
  }
  assert.equal(scrubbed["Accept-Encoding"], "gzip, deflate, br", "no Electron zstd");
  assert.equal(Object.keys(scrubbed).at(-1), "Authorization");
});

test("the antigravity usage probe uses the connection's own profile", async () => {
  const calls = stubFetch({});
  const { getAntigravityUsage } = await import("../../open-sse/services/usage/antigravity.ts");
  await getAntigravityUsage("antigravity", "tok", { clientProfile: "cli" }).catch(() => null);
  const call = calls.find((c) => (c.headers["User-Agent"] ?? "").startsWith("antigravity/"));
  assert.ok(call, "the usage probe must have run with an antigravity identity");
  assert.match(call.headers["User-Agent"], /^antigravity\/cli\//);
  assert.equal(call.headers["X-Goog-Api-Client"], undefined);
  // Node's fetch would send `gzip, deflate`; the native client asks for br too, and
  // the executor path already says so — a probe that does not is a mismatch.
  assert.equal(call.headers["Accept-Encoding"], "gzip, deflate, br");
});

// Codex has a fixed header surface too, and the extra-header direction matters as much
// as the missing one: the real client sends no `Version` and no Stainless block at all,
// so either one reads as a wrapped SDK rather than the Rust binary.
test("the codex send carries no SDK or proxy headers", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const headers = new CodexExecutor({ id: "codex" }).buildHeaders(
    {
      accessToken: "tok",
      providerSpecificData: { workspaceId: "ws-1" },
      requestEndpointPath: "/responses",
    } as never,
    true,
    { session_id: "sess-1" } as never,
    "gpt-5.1-codex"
  );
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  for (const leak of ["version", "x-forwarded-for", "via", "x-real-ip"]) {
    assert.equal(names.includes(leak), false, `${leak} must not reach the upstream`);
  }
  assert.equal(
    names.some((name) => name.startsWith("x-stainless-") || name.startsWith("x-omniroute-")),
    false,
    "no Stainless or OmniRoute marker on a Rust client's request"
  );
  assert.equal(headers.originator, "codex_cli_rs");
  assert.match(headers["User-Agent"] ?? "", /^codex_cli_rs\/\d+\.\d+\.\d+ \(/);
});
