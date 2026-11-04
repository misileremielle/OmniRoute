// Source ports of the operator's runtime patches (previously applied to the compiled
// bundle in a running container), plus the Claude Code Max-before-Pro preference.
import test from "node:test";
import assert from "node:assert/strict";

const { validateResponseQuality } = await import("../../open-sse/services/combo.ts");
const { isCodexModelExcludedByPlan } =
  await import("../../open-sse/services/codexPlanModelGate.ts");
const { getClaudePlanTier, narrowToPreferredClaudePlanTier } =
  await import("../../src/sse/services/claudePlanPreference.ts");
const { buildRequestTranslationErrorResult } =
  await import("../../open-sse/handlers/chatCore/requestTranslationError.ts");

const silentLog = { warn: () => {} };

// combo-quality-clone-cancel: a discarded replay must cancel the upstream reader.
test("cancelling a combo quality replay cancels the upstream body", async () => {
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
        )
      );
      // Leave the stream open: the remainder is forwarded lazily.
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const response = new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const result = await validateResponseQuality(response, true, silentLog);
  assert.equal(result.valid, true);
  assert.ok(result.clonedResponse?.body, "replay response expected");
  await result.clonedResponse!.body!.cancel("client gone");
  assert.equal(upstreamCancelled, true);
});

// codex-plan-model-filter
test("Codex Astra/Sol models are limited to Plus and Pro plan accounts", () => {
  const plus = { workspacePlanType: "plus" };
  const free = { workspacePlanType: "free" };
  for (const model of ["gpt-6-astra", "gpt-6.1-sol-high", "codex/gpt-7-sol"]) {
    assert.equal(isCodexModelExcludedByPlan("codex", model, plus), false, model);
    assert.equal(isCodexModelExcludedByPlan("codex", model, free), true, model);
    assert.equal(isCodexModelExcludedByPlan("codex", model, {}), true, `${model} unknown plan`);
  }
  assert.equal(isCodexModelExcludedByPlan("codex", "gpt-6-sol", { chatgptPlanType: "Pro" }), false);
  assert.equal(
    isCodexModelExcludedByPlan("codex", "gpt-6-sol", { chatgptPlanType: "promax" }),
    false
  );
  assert.equal(isCodexModelExcludedByPlan("cx", "gpt-6-astra", free), true);
  // Other models and other providers are untouched.
  assert.equal(isCodexModelExcludedByPlan("codex", "gpt-6", free), false);
  assert.equal(isCodexModelExcludedByPlan("codex", "gpt-6-solar", free), false);
  assert.equal(isCodexModelExcludedByPlan("openai", "gpt-6-astra", free), false);
});

// translation-error-stack: the server log keeps the stack, the response does not.
test("request translation failures log the stack without exposing it", async () => {
  const warnings: string[] = [];
  const error = new Error("bad tool schema");
  const result = await buildRequestTranslationErrorResult({
    error,
    log: { warn: (_tag: string, message: string) => warnings.push(message) },
  });
  assert.match(warnings.join("\n"), /Request translation failed: .*\n.*at /s);
  assert.doesNotMatch(JSON.stringify(result), /\n\s+at /);
});

// Claude Code: Max first, then Pro.
test("Claude plan tiers are read from every plan field the connections carry", () => {
  assert.equal(getClaudePlanTier({ subscriptionType: "max" }), "max");
  assert.equal(getClaudePlanTier({ rateLimitTier: "default_claude_max_20x" }), "max");
  assert.equal(getClaudePlanTier({ organizationType: "claude_max" }), "max");
  assert.equal(getClaudePlanTier({ subscriptionType: "pro" }), "pro");
  assert.equal(getClaudePlanTier({ plan: "Claude Pro" }), "pro");
  assert.equal(getClaudePlanTier({ organizationType: "claude_team" }), "other");
  assert.equal(getClaudePlanTier(undefined), "other");
});

test("Claude Code routes to Max accounts first, then Pro, then the rest", () => {
  const max = { id: "max", providerSpecificData: { subscriptionType: "max" } };
  const pro = { id: "pro", providerSpecificData: { subscriptionType: "pro" } };
  const other = { id: "other", providerSpecificData: {} };
  const ids = (list: { id: string }[]) => list.map((c) => c.id);
  assert.deepEqual(ids(narrowToPreferredClaudePlanTier("claude", [pro, other, max])), ["max"]);
  assert.deepEqual(ids(narrowToPreferredClaudePlanTier("claude", [other, pro])), ["pro"]);
  assert.deepEqual(ids(narrowToPreferredClaudePlanTier("claude", [other])), ["other"]);
  // Other providers are not affected.
  assert.deepEqual(ids(narrowToPreferredClaudePlanTier("codex", [pro, max])), ["pro", "max"]);
});
