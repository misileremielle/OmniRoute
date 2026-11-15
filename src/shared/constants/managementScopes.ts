/**
 * Management API key scopes — the set of API key scopes that authorize a
 * Bearer key on management routes (`/api/*` excluding `/api/v1/*` and the
 * public allowlist).
 *
 * Single source of truth shared by:
 *   - `src/lib/api/requireManagementAuth.ts` (`hasManageScope`)
 *   - `src/shared/utils/apiAuth.ts` (`validateBearerApiKeyForManagement`)
 *
 * Keep both helpers in sync by importing `MANAGEMENT_API_KEY_SCOPES` from
 * here — never re-declare the list inline.
 */

/** Canonical scope name granted to the default environment key. */
export const MANAGE_SCOPE = "manage";

/**
 * Set of scopes that grant access to management API routes.
 * `admin` is treated as a superset of `manage`.
 */
export const MANAGEMENT_API_KEY_SCOPES = new Set<string>(["manage", "admin"]);

/**
 * Narrow scopes (#14304) for the cache management routes. A machine client
 * that holds `read:cache` may read `/api/cache`, and one that holds
 * `write:cache` may flush it. These stay OUT of
 * `MANAGEMENT_API_KEY_SCOPES`: they open only the cache routes, never the
 * rest of the management API. `manage` and `admin` still pass both.
 */
export const CACHE_READ_SCOPE = "read:cache";
export const CACHE_WRITE_SCOPE = "write:cache";

export function hasCacheScope(scopes: readonly string[] = [], scope: string): boolean {
  if (hasManageScope(scopes)) return true;
  return scopes.includes(scope);
}

/**
 * Check whether any of the given scopes authorizes management API access.
 */
export function hasManageScope(scopes: readonly string[] = []): boolean {
  for (const scope of scopes) {
    if (MANAGEMENT_API_KEY_SCOPES.has(scope)) return true;
  }
  return false;
}
