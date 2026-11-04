import test from "node:test";
import assert from "node:assert/strict";

import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

// Bug: an OpenAI /v1/chat/completions client on the Claude Code provider sometimes got
// nothing at all. When Claude ended a turn with no visible text (only a signature-only
// thinking block, or end_turn with no block), the translator forwarded
// `finish_reason: "stop"` + `data: [DONE]` and the empty-content error was appended
// only when the upstream closed — after [DONE], where OpenAI clients have stopped
// reading. The verdict must now be delivered before the client's [DONE].

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    model: "claude-opus-4-8",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const EMPTY_TURN = chunk({ role: "assistant" }) + chunk({}, "stop") + "data: [DONE]\n\n";
const TEXT_TURN =
  chunk({ role: "assistant" }) +
  chunk({ content: "hello" }) +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

async function run(sse: string, permitsEmptyTurn?: () => boolean) {
  let error: (Error & { statusCode?: number }) | null = null;
  let completed = false;
  let upstreamFullyRead = false;
  const encoder = new TextEncoder();
  // Split so [DONE] shares a chunk with the stop frame, as translators emit it.
  const parts = [sse.slice(0, sse.indexOf("data:", 10)), sse.slice(sse.indexOf("data:", 10))];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.enqueue(encoder.encode(": trailing keepalive\n\n"));
      controller.close();
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        upstreamFullyRead = true;
      },
    })
  );
  const streamController = {
    clientResponseFormat: FORMATS.OPENAI,
    isConnected: () => true,
    handleComplete() {
      completed = true;
    },
    handleError(err: Error & { statusCode?: number }) {
      error = err;
    },
    markClientTerminalSeen() {},
  };
  const wrapped = createDisconnectAwareStream(
    { readable, writable: new WritableStream() },
    streamController,
    { permitsEmptyTurn }
  );
  let out = "";
  const reader = wrapped.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return { out, error, completed, upstreamFullyRead };
}

test("an empty OpenAI turn reports its error before the client's [DONE]", async () => {
  const { out, error, completed, upstreamFullyRead } = await run(EMPTY_TURN);
  assert.equal(error?.message, "Provider returned empty content");
  assert.equal(completed, false);
  const firstDone = out.indexOf("data: [DONE]");
  const errorAt = out.indexOf('"finish_reason":"error"');
  assert.ok(errorAt > 0, "error frame missing");
  assert.ok(errorAt < firstDone, "error frame must precede [DONE]");
  assert.equal(out.match(/data: \[DONE\]/g)?.length, 1);
  // The upstream remainder is drained (translator flush / usage still run), not dropped.
  assert.equal(upstreamFullyRead, true);
});

test("a turn with content passes through unchanged", async () => {
  const { out, error, completed } = await run(TEXT_TURN);
  assert.equal(error, null);
  assert.equal(completed, true);
  assert.ok(out.startsWith(TEXT_TURN));
});

test("a trusted native empty turn is still a clean empty success", async () => {
  const { out, error, completed } = await run(EMPTY_TURN, () => true);
  assert.equal(error, null);
  assert.equal(completed, true);
  assert.doesNotMatch(out, /finish_reason":"error"/);
  assert.equal(out.match(/data: \[DONE\]/g)?.length, 1);
});
