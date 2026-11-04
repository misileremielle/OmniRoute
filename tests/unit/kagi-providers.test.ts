import test from "node:test";
import assert from "node:assert/strict";

import {
  KagiAssistantExecutor,
  buildKagiPrompt,
  normalizeKagiSessionToken,
} from "../../open-sse/executors/kagi-assistant.ts";
import { SEARCH_PROVIDERS } from "../../open-sse/config/searchRegistry.ts";

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify({ event })}\n\n`;
const TURN = [
  frame({ type: "turn.started" }),
  frame({ type: "node.created", node_id: "t", payload: { kind: "thinking" } }),
  frame({ type: "node.delta", node_id: "t", payload: { delta: "hmm" } }),
  frame({ type: "node.created", node_id: "a", payload: { kind: "text" } }),
  frame({
    type: "reference.added",
    payload: { ref_id: "r1", title: "Doc", url: "https://x.test" },
  }),
  frame({ type: "node.delta", node_id: "a", payload: { delta: " Hello [^r" } }),
  frame({ type: "node.delta", node_id: "a", payload: { delta: "1#2] world" } }),
  frame({
    type: "turn.completed",
    payload: { usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0, model_version: "m" } },
  }),
].join("");

function stubKagi(streamBody: string) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith("/stream")
      ? new Response(streamBody, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ branch_uuid: "b1", assistant_turn_uuid: "turn-1" });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const input = (stream: boolean) =>
  ({
    body: { model: "ki_quick", messages: [{ role: "user", content: "hi" }] },
    credentials: { apiKey: "https://kagi.com/search?token=abc.def" },
    stream,
  }) as unknown as Parameters<KagiAssistantExecutor["execute"]>[0];

test("session tokens are read from a link, a cookie or the bare value", () => {
  assert.equal(normalizeKagiSessionToken("https://kagi.com/search?token=abc.def&x=1"), "abc.def");
  assert.equal(normalizeKagiSessionToken("Cookie: a=1; kagi_session=abc.def"), "abc.def");
  assert.equal(normalizeKagiSessionToken(" abc.def "), "abc.def");
});

test("a lone user message passes through; history is folded into one prompt", () => {
  assert.equal(buildKagiPrompt([{ role: "user", content: "hi" }]), "hi");
  assert.equal(
    buildKagiPrompt([
      { role: "system", content: "Be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]),
    "System: Be brief\n\nUser: hi\n\nAssistant: hello\n\nUser: bye"
  );
});

test("non-streaming: starts a turn, reads its stream and returns a chat completion", async () => {
  const kagi = stubKagi(TURN);
  try {
    const { response } = await new KagiAssistantExecutor().execute(input(false));
    const json = await response.json();
    assert.equal(kagi.calls[0].url, "https://assistant.kagi.com/api/v2/conversations");
    assert.equal(kagi.calls[1].url, "https://assistant.kagi.com/api/v2/turns/turn-1/stream");
    const headers = kagi.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Cookie, "kagi_session=abc.def");
    assert.deepEqual(JSON.parse(String(kagi.calls[0].init.body)), {
      content: "hi",
      model: "ki_quick",
    });
    assert.equal(
      json.choices[0].message.content,
      "Hello [^1] world\n\n[^1]: [Doc](https://x.test)"
    );
    assert.equal(json.choices[0].message.reasoning_content, "hmm");
    assert.deepEqual(json.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  } finally {
    kagi.restore();
  }
});

test("streaming emits OpenAI chunks ending in stop and [DONE]", async () => {
  const kagi = stubKagi(TURN);
  try {
    const { response } = await new KagiAssistantExecutor().execute(input(true));
    const text = await response.text();
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /"reasoning_content":"hmm"/);
    assert.match(text, /"content":"Hello "/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  } finally {
    kagi.restore();
  }
});

test("a failed or truncated turn is reported, not returned as an empty success", async () => {
  const failed = stubKagi(frame({ type: "turn.failed", payload: { error_code: "quota" } }));
  try {
    const { response } = await new KagiAssistantExecutor().execute(input(false));
    assert.equal(response.status, 502);
    assert.match(await response.text(), /quota/);
  } finally {
    failed.restore();
  }
  const cut = stubKagi(frame({ type: "turn.started" }));
  try {
    const { response } = await new KagiAssistantExecutor().execute(input(true));
    assert.match(await response.text(), /ended before a final response/);
  } finally {
    cut.restore();
  }
});

test("Kagi Search uses the official v1 endpoint with a Bearer key", () => {
  const config = SEARCH_PROVIDERS["kagi-search"];
  assert.equal(config.baseUrl, "https://kagi.com/api/v1/search");
  assert.equal(config.authHeader, "bearer");
  assert.equal(config.method, "POST");
});
