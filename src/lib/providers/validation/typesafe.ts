/**
 * TypeSafe AI (System One / Jev) API-key validation, also used for
 * operator-added System One-compatible endpoints (OpenRouter, self-hosted).
 *
 * Probes POST /v1/systemone with a tiny choice question. A 2xx with a parseable
 * choice means the key works; 401/403 means invalid; everything else is treated
 * as unavailable (credentials may still be fine).
 */

import {
  evaluateSystemOneChoice,
  type SystemOneChoiceUnavailable,
} from "@omniroute/open-sse/services/typesafe/systemOne.ts";
import {
  normalizeSystemOneModelForBase,
  sanitizeSystemOneBaseUrl,
} from "@omniroute/open-sse/config/systemOneRegistry.ts";

export async function validateTypesafeProvider({
  apiKey,
  baseUrl,
  model,
  label = "TypeSafe",
  fetchImpl,
}: {
  apiKey?: string | null;
  /** System One server root; default api.typesafe.ai. */
  baseUrl?: string | null;
  /** Probe model; default jev-latest (OpenRouter-mapped for OpenRouter bases). */
  model?: string | null;
  label?: string;
  fetchImpl?: typeof fetch;
}) {
  const base = baseUrl ? sanitizeSystemOneBaseUrl(baseUrl) : undefined;
  const result = await evaluateSystemOneChoice({
    apiKey,
    ...(base ? { baseUrl: base, model: normalizeSystemOneModelForBase(base, model || "") } : {}),
    ...(!base && model ? { model } : {}),
    state: "ping",
    instructions: "Pick any option.",
    criteria: {
      ok: "A valid routing destination",
      other: "Any other destination",
    },
    timeoutMs: 10_000,
    fetchImpl,
  });

  if (result.ok) {
    return { valid: true, error: null, method: "typesafe_systemone" };
  }
  // `strict: false` does not narrow the union by the boolean `ok`; past the early return it is the failure arm.
  const failure = result as SystemOneChoiceUnavailable;

  if (failure.reason === "missing_api_key") {
    return { valid: false, error: "API key is required" };
  }

  if (failure.reason === "http_error" && (failure.status === 401 || failure.status === 403)) {
    return { valid: false, error: "Invalid API key" };
  }

  if (failure.reason === "http_error" && failure.status === 429) {
    return {
      valid: true,
      error: null,
      method: "typesafe_systemone",
      warning: "Rate limited, but credentials appear valid",
    };
  }

  if (failure.reason === "timeout" || failure.reason === "network_error") {
    return {
      valid: false,
      error: `${label} unreachable (${failure.reason})`,
    };
  }

  return {
    valid: false,
    error: failure.detail || `${label} validation failed (${failure.reason})`,
  };
}
