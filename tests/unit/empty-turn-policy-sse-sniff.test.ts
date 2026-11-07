import test from "node:test";
import assert from "node:assert/strict";

import {
  getEmptyTurnDiagnostics,
  hasTrustedEmptyTurn,
  markEmptyTurnExecution,
} from "../../open-sse/utils/emptyTurnPolicy.ts";

// Bug: the trusted empty-turn observer chose SSE vs JSON parsing from the response
// content-type alone. In production a Codex stream reached it without a
// `text/event-stream` content-type, so the whole SSE body was parsed as one JSON
// document (diagnostics: eventCount 0, unparsedFrames 1). The turn was never
// trusted, and a clean empty Codex answer (an empty `output_text`, which
// gpt-6.1-sol returns when told to stay silent) reached Anthropic /v1/messages
// clients as a 502 "Claude returned an empty response (no content block)".

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CREDS = { connectionId: "conn-1", accessToken: "token" };

const sse = (type: string, payload: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
};
const EMPTY_FINAL_ANSWER =
  sse("response.created", {
    sequence_number: 0,
    response: { id: "r", object: "response", status: "in_progress", output: [], error: null },
  }) +
  sse("response.output_item.added", {
    sequence_number: 1,
    output_index: 0,
    item: { ...message, status: "in_progress", content: [] },
  }) +
  sse("response.output_text.done", {
    sequence_number: 2,
    output_index: 0,
    item_id: "msg_1",
    content_index: 0,
    text: "",
  }) +
  sse("response.output_item.done", { sequence_number: 3, output_index: 0, item: message }) +
  sse("response.completed", {
    sequence_number: 4,
    response: {
      id: "r",
      object: "response",
      status: "completed",
      output: [message],
      error: null,
      usage: { input_tokens: 9, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } },
    },
  });

async function observe(body: string, headers: Record<string, string>, chunkSize = 37) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += chunkSize) {
        controller.enqueue(encoder.encode(body.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  const observed = markEmptyTurnExecution(new Response(stream, { headers }), CODEX_URL, CREDS);
  await observed.text();
  return observed;
}

for (const [label, headers] of [
  ["no content-type", {}],
  ["application/octet-stream", { "content-type": "application/octet-stream" }],
  ["application/json", { "content-type": "application/json" }],
] as const) {
  test(`a Codex SSE stream with ${label} is still observed as SSE and trusted`, async () => {
    const observed = await observe(EMPTY_FINAL_ANSWER, headers);
    const diagnostics = getEmptyTurnDiagnostics(observed) as Record<string, unknown>;
    assert.equal(diagnostics.unparsedFrames, 0);
    assert.equal(diagnostics.eventCount, 5);
    assert.equal(hasTrustedEmptyTurn(observed), true);
  });
}

test("a body whose first frame is an SSE comment is recognised as SSE", async () => {
  const observed = await observe(`: keepalive\n\n${EMPTY_FINAL_ANSWER}`, {});
  assert.equal(hasTrustedEmptyTurn(observed), true);
});

test("a JSON body without a content-type is still parsed as one JSON document", async () => {
  const completed = {
    id: "r",
    object: "response",
    status: "completed",
    output: [message],
    usage: { input_tokens: 9, output_tokens: 4 },
  };
  const observed = await observe(`  ${JSON.stringify(completed)}`, {});
  const diagnostics = getEmptyTurnDiagnostics(observed) as Record<string, unknown>;
  assert.equal(diagnostics.eventCount, 1);
  assert.equal(hasTrustedEmptyTurn(observed), true);
});

test("an SSE stream that ends without a terminal stays untrusted", async () => {
  const truncated = EMPTY_FINAL_ANSWER.slice(
    0,
    EMPTY_FINAL_ANSWER.indexOf("event: response.completed")
  );
  const observed = await observe(truncated, {});
  assert.equal(hasTrustedEmptyTurn(observed), false);
});
