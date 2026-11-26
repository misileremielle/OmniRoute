/**
 * CCH signing must only touch the `cch=00000;` placeholder inside the
 * billing-header block, never user text that merely looks like `cch=xxxxx;`.
 *
 * The billing header is injected as system block[0]
 * (`x-anthropic-billing-header: cc_version=…; cc_entrypoint=…; cch=00000;`).
 * The CLI fingerprint serialises `messages` before `system`, so the old
 * first-match `cch=[0-9a-f]{5};` rewrite hit user text (for example a tool
 * result quoting this repo's own source) and left the real header unsigned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { computeCCH, signRequestBody } from "../../open-sse/services/claudeCodeCCH.ts";

const realFetch = globalThis.fetch;
type Call = { url: string; body: string };
function stubFetch() {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (!body) return new Response("{}", { status: 200 }); // background bootstrap GET
    calls.push({ url: String(url), body });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

const CLI_HEADERS = { "user-agent": "claude-cli/2.1.0 (external, cli)", "x-app": "cli" };
const oauth = () => ({
  accessToken: "test-token",
  connectionId: "cch-c1",
  providerSpecificData: {},
});

describe("signRequestBody anchors on the billing header", () => {
  it("signs the billing header placeholder and leaves cch-like user text untouched", async () => {
    const body =
      '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":[{"type":"text","text":"log line: cch=abcde; keep me"}]}],' +
      '"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.1e2; cc_entrypoint=cli; cch=00000;"}]}';
    const signed = await signRequestBody(body);
    assert.ok(signed.includes("log line: cch=abcde; keep me"), "user text must not be rewritten");
    assert.ok(!signed.includes("cch=00000;"), "billing header must carry the signed value");
    assert.match(
      signed,
      /cc_entrypoint=cli; cch=[0-9a-f]{5};/,
      "signed token must be in the billing header"
    );
  });

  it("signs the real billing header when user text starts like a billing header", async () => {
    const lookalike =
      "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli; cch=00000;";
    const body =
      `{"messages":[{"role":"user","content":[{"type":"text","text":"${lookalike}"}]}],` +
      '"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.1e2; cc_entrypoint=cli; cch=00000;"}]}';
    const signed = await signRequestBody(body);
    const parsed = JSON.parse(signed);
    assert.equal(parsed.messages[0].content[0].text, lookalike, "user text must not be rewritten");
    assert.match(
      parsed.system[0].text,
      /cc_entrypoint=cli; cch=(?!00000)[0-9a-f]{5};$/,
      "the real billing header must carry the signed value"
    );
  });

  it("leaves a billing-header-like user text alone when the body has no billing header", async () => {
    const body =
      '{"messages":[{"role":"user","content":[{"type":"text","text":"x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli; cch=00000;"}]}]}';
    const signed = await signRequestBody(body);
    assert.equal(signed, body, "no billing header means nothing to sign");
  });

  it("does not reach past an already-signed billing header into later user text", async () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.1e2; cc_entrypoint=cli; cch=a3ae1;"}],' +
      '"messages":[{"role":"user","content":"quote: cch=00000; end"}]}';
    const signed = await signRequestBody(body);
    assert.equal(signed, body, "the placeholder search must stay inside the billing header value");
  });

  it("returns the body unchanged when no billing header exists (cch-like user text only)", async () => {
    const body =
      '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"see cch=abcde; in the log"}]}';
    const signed = await signRequestBody(body);
    assert.equal(signed, body, "no billing header means nothing to sign");
  });

  it("returns the body unchanged when the billing header has no placeholder", async () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.1e2; cc_entrypoint=cli; cch=a3ae1;"}]}';
    const signed = await signRequestBody(body);
    assert.equal(signed, body, "an already-signed header must pass through");
  });

  it("hashes the body bytes that still contain the placeholder", async () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.1e2; cc_entrypoint=cli; cch=00000;"}]}';
    const signed = await signRequestBody(body);
    const expected = await computeCCH(new TextEncoder().encode(body));
    assert.ok(
      signed.includes(`cc_entrypoint=cli; cch=${expected};`),
      "token must be the hash over the placeholder bytes"
    );
  });

  it("still signs a legacy top-level-key billing header", async () => {
    const body =
      '{"x-anthropic-billing-header":"cc_version=2.1.280.1e2; cch=00000;","model":"claude"}';
    const signed = await signRequestBody(body);
    assert.ok(!signed.includes("cch=00000"), "key-form placeholder must still be replaced");
  });
});

describe("wire: executor CCH signing", () => {
  it("does not rewrite user text that looks like cch=xxxxx; and signs the real header", async () => {
    const calls = stubFetch();
    await new DefaultExecutor("claude").execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [
          { role: "user", content: [{ type: "text", text: "log line: cch=abcde; keep me" }] },
        ],
      },
      stream: false,
      credentials: oauth(),
      clientHeaders: CLI_HEADERS,
    } as never);
    globalThis.fetch = realFetch;
    const sent = JSON.parse(calls[0].body);
    assert.equal(
      sent.messages[0].content[0].text,
      "log line: cch=abcde; keep me",
      "user text must not be rewritten"
    );
    assert.doesNotMatch(
      sent.system[0].text,
      /cch=00000;/,
      "billing header must carry the signed value"
    );
  });

  it("leaves a plain API-key request with cch-like user text completely untouched", async () => {
    const calls = stubFetch();
    await new DefaultExecutor("claude").execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "see cch=abcde; in the log" }],
      },
      stream: false,
      credentials: { apiKey: "test-key", connectionId: "cch-c2", providerSpecificData: {} },
    } as never);
    globalThis.fetch = realFetch;
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.messages[0].content, "see cch=abcde; in the log");
  });

  it("control: with no cch-like user text the billing header is signed", async () => {
    const calls = stubFetch();
    await new DefaultExecutor("claude").execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
      stream: false,
      credentials: oauth(),
      clientHeaders: CLI_HEADERS,
    } as never);
    globalThis.fetch = realFetch;
    const billing = JSON.parse(calls[0].body).system[0].text;
    assert.doesNotMatch(billing, /cch=00000;/, "billing header must carry the signed value");
    assert.match(billing, /cch=[0-9a-f]{5};/);
  });
});

describe("re-signing a mutated retry body", () => {
  const billing = "x-anthropic-billing-header: cc_version=2.1.332.18b; cc_entrypoint=cli; cch=";
  const body = (maxTokens: number, cch = "00000") =>
    `{"model":"claude-sonnet-4-5","max_tokens":${maxTokens},` +
    `"system":[{"type":"text","text":"${billing}${cch};"}],"messages":[{"role":"user","content":"hi"}]}`;

  it("replaces a token the first send already wrote", async () => {
    const signed = await signRequestBody(body(64));
    // A retry rewrites the body — the token above is now stale. The change has to
    // be one the hash view keeps: `max_tokens` is stripped from it.
    const mutated = signed.replace('"content":"hi"', '"content":"hi again"');
    const resigned = await signRequestBody(mutated, { resign: true });
    // Same body, token reset to the placeholder → the reference signature.
    const reference = await signRequestBody(mutated.replace(/cch=[0-9a-f]{5};/, "cch=00000;"));
    assert.equal(resigned, reference);
    assert.notEqual(resigned, mutated, "the stale token must be replaced");
  });

  it("still passes an already-signed header through without the flag", async () => {
    const signed = await signRequestBody(body(64));
    assert.equal(await signRequestBody(signed), signed);
  });

  it("re-signing without a token leaves the body alone", async () => {
    const plain = '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}';
    assert.equal(await signRequestBody(plain, { resign: true }), plain);
  });
});

describe("wire: a retry re-signs the body", () => {
  it("replaces the cch on a thinking-budget clamp retry", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (!body) return new Response("{}", { status: 200 });
      calls.push(body);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { message: "thinking_budget must be in the range [-1, 8000]" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await new DefaultExecutor("claude").execute({
      model: "claude-sonnet-4-5",
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 32000 },
        messages: [{ role: "user", content: "hello" }],
      },
      stream: false,
      credentials: oauth(),
      clientHeaders: CLI_HEADERS,
    } as never);
    globalThis.fetch = realFetch;

    assert.equal(calls.length, 2, "the clamp must retry");
    const first = JSON.parse(calls[0]).system[0].text.match(/cch=([0-9a-f]{5});/)![1];
    const second = JSON.parse(calls[1]).system[0].text.match(/cch=([0-9a-f]{5});/)![1];
    assert.notEqual(second, first, "the stale token must not ride a rewritten body");
    assert.notEqual(second, "00000");
  });
});

// Learned caps are recorded process-wide per provider+model, so each case needs
// its own model id or a previous case pre-clamps the body and no 400 happens.
const CAPTURE_MODEL = "claude-sonnet-4-5-hash-change";
const NOHASH_MODEL = "claude-sonnet-4-5-nohash-change";

describe("wire: every recovery re-signs", () => {
  it("replaces the cch on a max_tokens ceiling retry", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (!body) return new Response("{}", { status: 200 });
      calls.push(body);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { message: "max_tokens: expected a value <= 8192" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await new DefaultExecutor("claude").execute({
      model: CAPTURE_MODEL,
      body: {
        model: CAPTURE_MODEL,
        // The clamp squeezes the budget to stay under the new max_tokens, and
        // `budget_tokens` (unlike `max_tokens`) is part of the hash view — so the
        // retry body really does differ in the hashed bytes here.
        thinking: { type: "enabled", budget_tokens: 32000 },
        max_tokens: 64000,
        messages: [{ role: "user", content: "hello" }],
      },
      stream: false,
      credentials: oauth(),
      clientHeaders: CLI_HEADERS,
    } as never);
    globalThis.fetch = realFetch;

    assert.equal(calls.length, 2, "the ceiling clamp must retry");
    const first = JSON.parse(calls[0]).system[0].text.match(/cch=([0-9a-f]{5});/)![1];
    const second = JSON.parse(calls[1]).system[0].text.match(/cch=([0-9a-f]{5});/)![1];
    assert.notEqual(second, first, "a rewritten body must not keep the old token");
  });
});

describe("a retry that only changes non-hashed fields", () => {
  it("keeps the token when the hash view is unchanged, and it stays a live value", async () => {
    // `max_tokens` is stripped from the hash view, so clamping it alone must not
    // produce a different token — but it must still be a real one (never 00000).
    const calls: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (!body) return new Response("{}", { status: 200 });
      calls.push(body);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { message: "max_tokens: expected a value <= 8192" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await new DefaultExecutor("claude").execute({
      model: NOHASH_MODEL,
      body: {
        model: NOHASH_MODEL,
        max_tokens: 64000,
        messages: [{ role: "user", content: "hello" }],
      },
      stream: false,
      credentials: oauth(),
      clientHeaders: CLI_HEADERS,
    } as never);
    globalThis.fetch = realFetch;

    assert.equal(calls.length, 2);
    const second = JSON.parse(calls[1]).system[0].text.match(/cch=([0-9a-f]{5});/)![1];
    assert.notEqual(second, "00000");
    const reference = await signRequestBody(calls[1].replace(/cch=[0-9a-f]{5};/, "cch=00000;"));
    assert.match(reference, new RegExp(`cch=${second};`));
  });
});
