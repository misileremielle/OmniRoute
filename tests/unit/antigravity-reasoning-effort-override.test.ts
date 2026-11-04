import test from "node:test";
import assert from "node:assert/strict";

// The cloudcode envelope's top-level `reasoningEffortOverride` field (ported from upstream
// decolua/9router#2584), resolved against OmniRoute's canonical reasoning-effort vocabulary.
const { antigravityToOpenAIRequest } =
  await import("../../open-sse/translator/request/antigravity-to-openai.ts");

test("antigravity->openai: an explicit reasoningEffortOverride wins over the request's own thinkingConfig", () => {
  const result = antigravityToOpenAIRequest(
    "cx/gpt-5.6-sol",
    {
      model: "gemini-3-flash-agent",
      reasoningEffortOverride: "high",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
      },
    },
    false
  );

  // thinkingBudget 512 alone would derive "low" (see the budget-tier test below) — the
  // override must take priority end-to-end.
  assert.equal(result.reasoning_effort, "high");
});

test("antigravity->openai: an explicit 'none' override suppresses reasoning_effort even under a thinking request", () => {
  const result = antigravityToOpenAIRequest(
    "cx/gpt-5.6-sol",
    {
      reasoningEffortOverride: "none",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 32000 } },
      },
    },
    false
  );

  assert.equal("reasoning_effort" in result, false);
});

test("antigravity->openai: reasoning-only override applies without a model override present", () => {
  const result = antigravityToOpenAIRequest(
    "gemini-3-flash-agent",
    {
      reasoningEffortOverride: "medium",
      request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    },
    false
  );

  assert.equal(result.model, "gemini-3-flash-agent");
  assert.equal(result.reasoning_effort, "medium");
});

test("antigravity->openai: no override falls back to the pre-existing thinkingConfig-derived tiers", () => {
  const low = antigravityToOpenAIRequest(
    "gpt-4o",
    { request: { generationConfig: { thinkingConfig: { thinkingBudget: 512 } } } },
    false
  );
  const medium = antigravityToOpenAIRequest(
    "gpt-4o",
    { request: { generationConfig: { thinkingConfig: { thinkingBudget: 3000 } } } },
    false
  );
  const high = antigravityToOpenAIRequest(
    "gpt-4o",
    { request: { generationConfig: { thinkingConfig: { thinkingBudget: 32000 } } } },
    false
  );

  assert.equal(low.reasoning_effort, "low");
  assert.equal(medium.reasoning_effort, "medium");
  assert.equal(high.reasoning_effort, "high");
});

test("antigravity->openai: an unrecognized override value is ignored (falls back to derived behavior)", () => {
  const result = antigravityToOpenAIRequest(
    "gpt-4o",
    {
      reasoningEffortOverride: "extreme",
      request: { generationConfig: { thinkingConfig: { thinkingBudget: 512 } } },
    },
    false
  );

  assert.equal(result.reasoning_effort, "low");
});
