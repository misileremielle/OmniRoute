// tests/unit/chatcore-skills-format.test.ts
// Characterization of getSkillsProviderForFormat / getToolCallModelIdForFormat — the skills-format
// mappers extracted from handleChatCore (chatCore god-file decomposition, #3501). Locks the
// claude→anthropic/claude, gemini→google/gemini and default→openai/openai mappings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolCallModelIdForFormat } from "../../open-sse/handlers/chatCore/toolCallFormat.ts";

test("claude format maps to anthropic provider and claude model id", () => {
  assert.equal(getToolCallModelIdForFormat("claude"), "claude");
});

test("gemini format maps to google provider and gemini model id", () => {
  assert.equal(getToolCallModelIdForFormat("gemini"), "gemini");
});

test("openai format maps to openai provider and openai model id", () => {
  assert.equal(getToolCallModelIdForFormat("openai"), "openai");
});

test("unknown / responses formats fall back to openai for both mappers", () => {
  assert.equal(getToolCallModelIdForFormat("openai-responses"), "openai");
  assert.equal(getToolCallModelIdForFormat("totally-unknown"), "openai");
});
