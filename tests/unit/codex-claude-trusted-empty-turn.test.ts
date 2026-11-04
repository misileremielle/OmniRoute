import test from "node:test";
import assert from "node:assert/strict";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  hasTrustedEmptyTurn,
  markEmptyTurnExecution,
} from "../../open-sse/utils/emptyTurnPolicy.ts";

// Bug: an Anthropic /v1/messages client routed to Codex got a 502 "Claude returned an
// empty response (no content block)" whenever Codex finished a turn cleanly with only an
// encrypted reasoning item (summary: [] — common for short reasoning, and always for
// models where no summary is requested). The same turn on /v1/chat/completions is a
// trusted empty 200 (emptyTurnPolicy.hasTrustedEmptyTurn). The translated-Claude per-event
// empty guard fired on message_delta before any trust check.

const sse = (type: string, payload: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const reasoning = { id: "rs_1", type: "reasoning", encrypted_content: "gAAAA", summary: [] };
const CODEX_REASONING_ONLY =
  sse("response.created", {
    response: { id: "r", object: "response", model: "gpt-5.5", status: "in_progress", output: [] },
  }) +
  sse("response.output_item.added", {
    output_index: 0,
    item: { id: "rs_1", type: "reasoning", summary: [] },
  }) +
  sse("response.output_item.done", { output_index: 0, item: reasoning }) +
  sse("response.completed", {
    response: {
      id: "r",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [reasoning],
      usage: { input_tokens: 9, output_tokens: 4, output_tokens_details: { reasoning_tokens: 4 } },
    },
  });

async function runClaudeClient(body: ReadableStream<Uint8Array>, permitsEmptyTurn: () => boolean) {
  const transform = createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE,
    "codex",
    null,
    null,
    "gpt-5.5",
    "conn-1",
    { model: "gpt-5.5" },
    null,
    null,
    null,
    false,
    false,
    false,
    new Set(),
    null,
    null,
    undefined,
    null,
    permitsEmptyTurn
  );
  let out = "";
  let error: Error | null = null;
  const reader = body.pipeThrough(transform).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
  } catch (err) {
    error = err as Error;
  }
  return { out, error };
}

function bodyOf(text: string) {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

test("trusted Codex reasoning-only turn reaches a Claude client as a clean empty end_turn", async () => {
  const native = new Response(CODEX_REASONING_ONLY, {
    headers: { "content-type": "text/event-stream" },
  });
  const observed = markEmptyTurnExecution(
    native,
    "https://chatgpt.com/backend-api/codex/responses",
    {
      connectionId: "conn-1",
      accessToken: "token",
    }
  );
  // The verdict is read lazily per event: the observer must already have parsed
  // response.completed when the translator emits message_delta.
  const { out, error } = await runClaudeClient(observed.body!, () => hasTrustedEmptyTurn(observed));
  assert.equal(error, null, `unexpected stream error: ${error?.message}`);
  assert.doesNotMatch(out, /no content block/);
  assert.match(out, /"stop_reason":"end_turn"/);
  assert.match(out, /message_stop/);
});

test("an untrusted upstream with the same empty turn still aborts with empty_response", async () => {
  const { error } = await runClaudeClient(bodyOf(CODEX_REASONING_ONLY), () => false);
  assert.ok(error, "expected the empty-turn guard to abort");
  assert.equal((error as Error & { code?: string }).code, "empty_response");
});

test("the empty-turn abort fires once, so the upstream writer is not hit by a TypeError", async () => {
  const transform = createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE,
    "codex",
    null,
    null,
    "gpt-5.5"
  );
  const reading = (async () => {
    const reader = transform.readable.getReader();
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      /* expected abort */
    }
  })();
  const writer = transform.writable.getWriter();
  // message_delta and message_stop are produced from the same upstream chunk; before
  // the guard the second abort forwarded onto the errored controller and the write
  // rejected with "TypeError: Unable to enqueue" instead of the empty_response error.
  const rejection = await writer.write(new TextEncoder().encode(CODEX_REASONING_ONLY)).then(
    () => null,
    (err: unknown) => err as Error & { code?: string }
  );
  await reading;
  if (rejection) {
    assert.notEqual(rejection.name, "TypeError", rejection.message);
    assert.equal(rejection.code, "empty_response");
  }
});
