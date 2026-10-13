/**
 * Some OpenAI-compatible upstreams finish a turn that made tool calls with
 * finish_reason "stop" instead of "tool_calls". Translated to Claude as
 * stop_reason "end_turn", agent clients such as Claude Code treat the turn as
 * finished and stop mid-task with the tool call still pending.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { translateResponse, initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function stopReasonFor(finishReason: string, withToolCall: boolean): unknown {
  const state = initState(FORMATS.CLAUDE);
  const chunks: Array<Record<string, unknown> | null> = [
    chunk({ role: "assistant", content: "Running it." }),
    ...(withToolCall
      ? [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "Bash", arguments: '{"command":"ls"}' },
              },
            ],
          }),
        ]
      : []),
    chunk({}, finishReason),
    null,
  ];
  const events: Array<Record<string, unknown>> = [];
  for (const c of chunks) {
    const out = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, c, state);
    if (out) events.push(...out.filter(Boolean));
  }
  const delta = events.find((e) => e.type === "message_delta")?.delta as
    Record<string, unknown> | undefined;
  return delta?.stop_reason;
}

test('a tool call finished with "stop" is reported as tool_use', () => {
  assert.equal(stopReasonFor("stop", true), "tool_use");
});

test('"tool_calls" still maps to tool_use and plain "stop" to end_turn', () => {
  assert.equal(stopReasonFor("tool_calls", true), "tool_use");
  assert.equal(stopReasonFor("stop", false), "end_turn");
});

test('a tool call cut off by "length" stays max_tokens', () => {
  assert.equal(stopReasonFor("length", true), "max_tokens");
});
