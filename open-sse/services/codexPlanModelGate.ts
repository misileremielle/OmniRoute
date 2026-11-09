/**
 * Codex "Astra" and "Sol" tier models (gpt-<version>-astra / gpt-<version>-sol, with
 * or without a suffix such as -high) are only served to paid ChatGPT plans. Route
 * them to Plus and Codex Pro (Standard / Extra / Max) accounts only; any other or
 * unknown plan is skipped for these models, as if the connection excluded them.
 */

import { getCodexPlanType } from "./codexPlanEligibility.ts";

const PLAN_RESTRICTED_CODEX_MODEL = /(^|\/)gpt-[\w.-]+?-(astra|sol)(-|$)/i;
const CODEX_PROVIDERS = new Set(["codex", "cx"]);
export const CODEX_PLAN_RESTRICTED_ALLOWED_PLANS = new Set(["plus", "prolite", "pro", "promax"]);

export function isCodexModelExcludedByPlan(
  provider: unknown,
  model: unknown,
  providerSpecificData: unknown
): boolean {
  if (typeof provider !== "string" || !CODEX_PROVIDERS.has(provider)) return false;
  if (!PLAN_RESTRICTED_CODEX_MODEL.test(String(model || ""))) return false;
  // Same plan keys and normalization as the upstream gate (planType, plan_type, ... too);
  // a missing or unknown plan stays excluded here.
  return !CODEX_PLAN_RESTRICTED_ALLOWED_PLANS.has(getCodexPlanType(providerSpecificData) ?? "");
}
