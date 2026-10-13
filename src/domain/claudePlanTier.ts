/**
 * Claude account plan preference: Max 20x accounts serve requests before Max 5x
 * accounts, and both before every other plan (Pro, Team, Enterprise, or no plan
 * recorded, e.g. a setup-token import). Lower tiers are only offered to the
 * selection strategy when no higher-tier account is available, so this works
 * the same under fill-first, round-robin and the other strategies.
 *
 * The plan comes from the OAuth bootstrap fields stored on the connection
 * (src/lib/oauth/providers/claude.ts): `organizationRateLimitTier` such as
 * "default_claude_max_20x", and `organizationType` such as "claude_max".
 */

interface ClaudeTierConnection {
  id: string;
  providerSpecificData?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 2 = Max 20x, 1 = Max 5x or Max without a recorded multiplier, 0 = any other plan. */
export function getClaudePlanRank(providerSpecificData: unknown): number {
  const data = asRecord(providerSpecificData);
  const tier =
    typeof data.organizationRateLimitTier === "string" ? data.organizationRateLimitTier : "";
  const type = typeof data.organizationType === "string" ? data.organizationType : "";
  const plan = `${tier} ${type}`.toLowerCase();
  if (/claude_max_20x/.test(plan)) return 2;
  if (/claude_max/.test(plan)) return 1;
  return 0;
}

/**
 * For the Claude provider, keep only the connections on the highest plan tier
 * present. `keepConnectionId` (an active exclusive lease) is always kept so the
 * lease can still resolve to its connection. Other providers pass through.
 */
export function preferHighestClaudePlan<T extends ClaudeTierConnection>(
  providerId: string,
  connections: T[],
  keepConnectionId?: string | null
): T[] {
  if (providerId !== "claude" || connections.length < 2) return connections;
  const ranks = connections.map((c) => getClaudePlanRank(c.providerSpecificData));
  const best = Math.max(...ranks);
  if (best === 0) return connections;
  return connections.filter((c, i) => ranks[i] === best || c.id === keepConnectionId);
}
