/**
 * Claude Code (`claude` OAuth) account preference: route to Claude Max accounts
 * first, then Claude Pro, then accounts whose plan is unknown or different (Team,
 * Enterprise, setup tokens without plan metadata).
 *
 * Applied as a narrowing of the eligible pool, so it composes with every routing
 * strategy: the strategy picks within the best plan tier that still has an
 * available account. Max accounts that are rate-limited, quota-exhausted, excluded
 * after a failure or otherwise filtered out never reach this point, so traffic
 * falls through to Pro only when no Max account can serve the request.
 */

export type ClaudePlanTier = "max" | "pro" | "other";

// Where Claude connections record their plan, most specific first: an imported
// credentials file's subscriptionType ("max" / "pro"), the OAuth plan claim, then
// the bootstrap rate-limit tier ("default_claude_max_20x") and organization type.
const PLAN_FIELDS = [
  "subscriptionType",
  "plan",
  "rateLimitTier",
  "organizationType",
  "organizationRateLimitTier",
] as const;

function tierOfValue(value: unknown): ClaudePlanTier | null {
  if (typeof value !== "string") return null;
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.includes("max")) return "max";
  if (tokens.includes("pro")) return "pro";
  return null;
}

export function getClaudePlanTier(providerSpecificData: unknown): ClaudePlanTier {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return "other";
  const data = providerSpecificData as Record<string, unknown>;
  for (const field of PLAN_FIELDS) {
    const tier = tierOfValue(data[field]);
    if (tier) return tier;
  }
  return "other";
}

const TIER_ORDER: readonly ClaudePlanTier[] = ["max", "pro"];

/** Keep only the best plan tier present (Max, else Pro, else everything). */
export function narrowToPreferredClaudePlanTier<T extends { providerSpecificData?: unknown }>(
  provider: string,
  connections: T[]
): T[] {
  if (provider !== "claude" || connections.length < 2) return connections;
  for (const tier of TIER_ORDER) {
    const inTier = connections.filter(
      (connection) => getClaudePlanTier(connection.providerSpecificData) === tier
    );
    if (inTier.length > 0) return inTier;
  }
  return connections;
}
