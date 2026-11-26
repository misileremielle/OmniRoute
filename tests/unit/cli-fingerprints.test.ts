import test from "node:test";
import assert from "node:assert/strict";

const { applyFingerprint } = await import("../../open-sse/config/cliFingerprints.ts");

test("Codex CLI fingerprint puts routing fields first, as the real client serializes them", () => {
  const body = {
    model: "gpt-5.5-low",
    stream: true,
    input: [{ role: "user", content: "hello" }],
    instructions: "You are Codex.",
    store: false,
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "auto",
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "conv-codex",
    service_tier: "priority",
  };

  const result = applyFingerprint("codex", {}, body);
  const orderedKeys = Object.keys(JSON.parse(result.bodyString));

  // openai/codex 0.172.0 ResponsesApiRequest field order: model and stream lead so a
  // gateway can read routing before the (potentially huge) input.
  assert.deepEqual(orderedKeys.slice(0, 9), [
    "model",
    "stream",
    "service_tier",
    "instructions",
    "input",
    "tools",
    "tool_choice",
    "reasoning",
    "store",
  ]);
  assert.ok(orderedKeys.indexOf("include") < orderedKeys.indexOf("prompt_cache_key"));
});
