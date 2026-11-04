/**
 * Codex "Astra" and "Sol" tier models (gpt-<version>-astra / gpt-<version>-sol, with
 * or without a suffix such as -high) are only served to paid ChatGPT plans. Route
 * them to Plus and Codex Pro (Standard / Extra / Max) accounts only; any other or
 * unknown plan is skipped for these models, as if the connection excluded them.
 */

const PLAN_RESTRICTED_CODEX_MODEL = /(^|\/)gpt-[\w.-]+?-(astra|sol)(-|$)/i;
const CODEX_PROVIDERS = new Set(["codex", "cx"]);
export const CODEX_PLAN_RESTRICTED_ALLOWED_PLANS = new Set(["plus", "prolite", "pro", "promax"]);

/** Plan string, read the way the Codex executor reads it (OAuth login first, then import). */
function codexPlanOf(providerSpecificData: unknown): string {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return "";
  const data = providerSpecificData as { workspacePlanType?: unknown; chatgptPlanType?: unknown };
  const plan =
    typeof data.workspacePlanType === "string" ? data.workspacePlanType : data.chatgptPlanType;
  return typeof plan === "string" ? plan.trim().toLowerCase() : "";
}

export function isCodexModelExcludedByPlan(
  provider: unknown,
  model: unknown,
  providerSpecificData: unknown
): boolean {
  if (typeof provider !== "string" || !CODEX_PROVIDERS.has(provider)) return false;
  if (!PLAN_RESTRICTED_CODEX_MODEL.test(String(model || ""))) return false;
  return !CODEX_PLAN_RESTRICTED_ALLOWED_PLANS.has(codexPlanOf(providerSpecificData));
}
