import type { RegistryEntry } from "../../shared.ts";

// Base models listed by Kagi's /api/init (account default: ki_quick). Any other id
// the account offers passes through.
const MODELS: Array<[string, string]> = [
  ["ki_quick", "Kagi Quick"],
  ["kimi-k2-7-code", "Kimi K2.7 Code"],
  ["kimi-k2-6", "Kimi K2.6"],
  ["glm-5-3-flash", "GLM-5.3-Flash"],
  ["claude-5-5-haiku", "Claude Haiku 5.5"],
  ["claude-5-5-opus", "Claude Opus 5.5"],
  ["qwen-3-8-flash", "Qwen3.8 Flash"],
  ["qwen-3-8-27b", "Qwen3.8 27B"],
  ["gpt-6-luna", "GPT 6 Luna"],
  ["gpt-oss-120b", "GPT OSS 120B"],
  ["deepseek-v4-1-flash", "DeepSeek V4.1 Flash"],
  ["gemini-3-1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["grok-4-3", "Grok 4.3"],
  ["mistral-small-4", "Mistral Small 4"],
  ["mistral-large", "Mistral Large 3"],
  ["hermes-4-405b-thinking", "Hermes-4-405B (reasoning)"],
  ["minimax-m3-1-flash", "MiniMax M3.1 Flash"],
];

export const kagi_assistantProvider: RegistryEntry = {
  id: "kagi-assistant",
  alias: "kagi",
  format: "openai",
  executor: "kagi-assistant",
  baseUrl: "https://assistant.kagi.com",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: MODELS.map(([id, name]) => ({ id, name, toolCalling: false })),
};
