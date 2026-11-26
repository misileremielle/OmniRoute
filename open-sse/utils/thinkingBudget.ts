/**
 * Thinking-budget helpers extracted from base.ts.
 *
 * Pure utilities for reading / clamping the thinking budget fields that
 * different providers nest inside the request body.
 */

export function hasActiveClaudeThinking(body: Record<string, unknown>): boolean {
  const thinking = body.thinking as Record<string, unknown> | undefined;
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
}

/**
 * Collect every `thinkingConfig` object in a transformed request body that holds
 * a thinking budget, wherever the provider's envelope nests it:
 *   - body.generationConfig.thinkingConfig            (native Gemini / openai→gemini)
 *   - body.request.generationConfig.thinkingConfig    (Antigravity Cloud Code envelope)
 *   - body.thinking                                   (Anthropic native, `budget_tokens`)
 * Returns only objects that actually carry a `thinkingBudget`/`thinking_budget`
 * field — a request without thinking config is never mutated.
 */
export function collectThinkingConfigs(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const configs: Array<Record<string, unknown>> = [];
  const envelopes: unknown[] = [
    root.generationConfig,
    (root.request as Record<string, unknown> | undefined)?.generationConfig,
  ];
  for (const env of envelopes) {
    if (!env || typeof env !== "object") continue;
    const tc = (env as Record<string, unknown>).thinkingConfig;
    if (tc && typeof tc === "object") {
      const tcr = tc as Record<string, unknown>;
      if (hasBudgetField(tcr)) configs.push(tcr);
    }
  }
  // Anthropic-native shape: `thinking: { type, budget_tokens }`. Without this the
  // Gemini-envelope scan alone is blind to /v1/messages bodies, so the
  // thinking-budget 400 clamp-and-retry never fired for Claude.
  const thinking = root.thinking;
  if (
    thinking &&
    typeof thinking === "object" &&
    hasBudgetField(thinking as Record<string, unknown>)
  ) {
    configs.push(thinking as Record<string, unknown>);
  }
  return configs;
}

const BUDGET_KEYS = ["thinkingBudget", "thinking_budget", "budget_tokens", "budgetTokens"] as const;

function hasBudgetField(config: Record<string, unknown>): boolean {
  return BUDGET_KEYS.some((key) => key in config);
}

/**
 * Read the first thinking budget found in the body (any supported nest / naming).
 * Returns null when the body carries no readable numeric budget.
 */
export function readNestedThinkingBudget(body: unknown): number | null {
  for (const tc of collectThinkingConfigs(body)) {
    for (const key of BUDGET_KEYS) {
      const n = Number(tc[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Clamp every thinking budget in the body down to `max` (only lowers; never
 * raises a budget already below max). Mutates in place. Returns true when at
 * least one budget was actually lowered (i.e. a retry would send a different
 * body) — false means the 400 was not caused by an over-max budget we hold, so
 * retrying would resend an identical body and loop.
 */
export function clampNestedThinkingBudget(body: unknown, max: number): boolean {
  let changed = false;
  for (const tc of collectThinkingConfigs(body)) {
    for (const key of BUDGET_KEYS) {
      const n = Number(tc[key]);
      if (Number.isFinite(n) && n > max) {
        tc[key] = max;
        changed = true;
      }
    }
  }
  return changed;
}
