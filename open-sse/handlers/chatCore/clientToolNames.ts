/**
 * chatCore client tool-name capture (chatCore god-file decomposition, slice 2).
 *
 * Extracted byte-identically from handleChatCore. Captures the client's own tool names BEFORE the
 * web-search / web-fetch fallback preparers inject synthetic tools, so the owner-provenance merge
 * (mergeInjectedFallbackOwnerNames) can tell tools the client already declared from tools OmniRoute
 * added. Without this, a client function named `omniroute_web_search` (colliding with the fallback
 * tool name) would be marked server-owned even though the client owns it.
 */

export function collectPreConversionClientToolNames(body: unknown): string[] {
  return (
    Array.isArray((body as Record<string, unknown>).tools)
      ? ((body as Record<string, unknown>).tools as unknown[])
      : []
  )
    .map((tool) => {
      if (!tool || typeof tool !== "object") return "";
      const record = tool as Record<string, unknown>;
      if (typeof record.name === "string") return record.name;
      const fn = record.function;
      if (
        fn &&
        typeof fn === "object" &&
        typeof (fn as Record<string, unknown>).name === "string"
      ) {
        return (fn as Record<string, unknown>).name as string;
      }
      return "";
    })
    .filter(Boolean);
}

interface FallbackPlan {
  enabled: boolean;
  toolName: string | null;
  convertedToolCount: number;
}

/**
 * Pure helper: merge web-search/web-fetch fallback tool names into the
 * builtin owner set. Adds a name only when plan.enabled===true,
 * plan.convertedToolCount>0, plan.toolName is non-null, and that name
 * did not already exist in the pre-conversion client tools (builtinToolNames)
 * OR in the original client tool names captured before fallback injection.
 * Does not mutate its input; returns a new result.
 */
export function mergeInjectedFallbackOwnerNames(
  injectionResult: { builtinToolNames: string[] },
  plans: FallbackPlan[],
  preConversionClientToolNames?: string[]
): { builtinToolNames: string[] } {
  const existing = new Set(injectionResult.builtinToolNames);
  if (preConversionClientToolNames) {
    for (const name of preConversionClientToolNames) {
      existing.add(name);
    }
  }
  const extraNames: string[] = [];
  for (const plan of plans) {
    if (
      plan.enabled &&
      plan.convertedToolCount > 0 &&
      plan.toolName &&
      !existing.has(plan.toolName)
    ) {
      extraNames.push(plan.toolName);
      existing.add(plan.toolName);
    }
  }
  return { builtinToolNames: [...injectionResult.builtinToolNames, ...extraNames] };
}

/** API key id that owns this request's server-side tool executions, when one is present. */
export function resolveToolOwnerId(apiKeyInfo: Record<string, unknown> | null): string | null {
  const rawId = apiKeyInfo?.id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  return null;
}
