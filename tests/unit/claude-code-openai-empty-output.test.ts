// OpenAI /v1/chat/completions clients on the Claude Code provider sometimes got no
// output while /v1/messages worked. Request side: an OpenAI reasoning_effort on an
// adaptive-only Claude model (Opus 4.8 / Opus 5 / Fable 5) became
// thinking:{type:"adaptive"} with the client's answer-sized max_tokens forwarded
// unchanged; adaptive reasoning spends from that same cap, so the model could think
// through all of it and stop with max_tokens and no text. Response side: text carried
// on content_block_start was dropped for OpenAI stream clients.
import test from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");
const { claudeToOpenAIResponse } =
  await import("../../open-sse/translator/response/claude-to-openai.ts");

const messages = [{ role: "user", content: "hi" }];

function toClaude(model: string, extra: Record<string, unknown>) {
  return openaiToClaudeRequest(model, { model, messages, ...extra }, true, { _provider: "claude" });
}

test("adaptive thinking keeps the client cap as answer room on top of thinking room", () => {
  const high = toClaude("claude-opus-4-8", { max_tokens: 2048, reasoning_effort: "high" });
  assert.deepEqual(high.thinking, { type: "adaptive" });
  assert.equal(high.output_config?.effort, "high");
  // 2048 answer room + high thinking room, bounded by the 128k Opus output cap.
  assert.equal(high.max_tokens, 128000);

  const low = toClaude("claude-opus-4-8", { max_tokens: 2048, reasoning_effort: "low" });
  assert.equal(low.max_tokens, 2048 + 1024);

  const viaCompletionTokens = toClaude("claude-opus-4-8", {
    max_completion_tokens: 4000,
    reasoning_effort: "medium",
  });
  assert.equal(viaCompletionTokens.max_tokens, 4000 + 10240);
});

test("requests without adaptive thinking or without a client cap are unchanged", () => {
  // No thinking: an explicit cap stays a hard limit.
  assert.equal(toClaude("claude-opus-4-8", { max_tokens: 2048 }).max_tokens, 2048);
  // No client cap: the 64k default is already ample and is left alone.
  assert.equal(toClaude("claude-opus-4-8", { reasoning_effort: "high" }).max_tokens, 64000);
  // Budgeted (non-adaptive) thinking keeps its existing fit.
  const sonnet = toClaude("claude-sonnet-4-5", { max_tokens: 4096, reasoning_effort: "medium" });
  assert.deepEqual(sonnet.thinking, { type: "enabled", budget_tokens: 10240 });
  assert.equal(sonnet.max_tokens, 4096 + 10240);
});

test("text carried on content_block_start reaches OpenAI stream clients", () => {
  const state: Record<string, unknown> = { toolCalls: new Map() };
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "m1", model: "claude-opus-4-8", usage: {} } },
    state
  );
  const started = claudeToOpenAIResponse(
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
    state
  ) as Array<{ choices: Array<{ delta: { content?: string } }> }> | null;
  const later = claudeToOpenAIResponse(
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    state
  ) as Array<{ choices: Array<{ delta: { content?: string } }> }> | null;
  const text = [...(started ?? []), ...(later ?? [])]
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("");
  assert.equal(text, "Hello world");

  // The normal empty start still emits nothing.
  const emptyState: Record<string, unknown> = { toolCalls: new Map() };
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "m2", model: "claude-opus-4-8", usage: {} } },
    emptyState
  );
  assert.equal(
    claudeToOpenAIResponse(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      emptyState
    ),
    null
  );
});
