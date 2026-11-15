/**
 * Compile-time deny-list: route prefixes whose handlers can spawn arbitrary local
 * subprocesses (npm install, node, python CLIs) on behalf of the
 * caller. These MUST NEVER appear in the manage-scope bypass list — regardless of
 * DB state — because reaching them from non-loopback would re-introduce the
 * GHSA-fhh6-4qxv-rpqj surface that the LOCAL_ONLY tier exists to close.
 *
 * Enforced at two layers:
 *   1. zod schema (`settingsSchemas.ts`): rejects `PATCH /api/settings` with error
 *      code `BYPASS_PREFIX_NOT_ALLOWED` if any entry in
 *      `localOnlyManageScopeBypassPrefixes` falls inside this set.
 *   2. runtime (`isLocalOnlyBypassableByManageScope` in `routeGuard.ts`): even if a
 *      malformed DB row claims a spawn-capable path is bypassable, the policy refuses.
 *
 * 🔒 This constant lives in `@/shared/constants` — a server-free leaf module — and
 * NOT in `@/server/authz/routeGuard`, on purpose. `settingsSchemas.ts` is reachable
 * from client components (dashboard onboarding wizard → validation barrel), and
 * importing it from `routeGuard.ts` dragged routeGuard's server runtime
 * (runtimeSettings → localDb → apiKeys → rateLimiter → ioredis) into the browser
 * bundle, breaking the Next CLI/client webpack build with
 * `Module not found: Can't resolve 'dns'/'net'`. Keeping the value here lets both the
 * client-safe schema and the server routeGuard import it with no server coupling.
 * Regression guard: `tests/unit/authz/spawn-capable-prefixes-client-safe.test.ts`.
 * Hard Rules #15 + #16.
 */
export const SPAWN_CAPABLE_PREFIXES: ReadonlyArray<string> = [
  "/api/services/", // T-10: can run npm install + spawn node processes
  "/api/version-manager/", // downloads, unpacks and runs the CLIProxyAPI binary (Hard Rules #15 + #16)
  "/api/local/", // T-12: 1-click local service launchers (Redis today) — must never be whitelistable via manage-scope bypass (Hard Rules #15 + #16)
  "/api/skills/collect/", // Chaos Mode dispatch prefix — must never be whitelistable via manage-scope bypass
  "/api/headroom/start", // spawns headroom-ai python CLI — must never be bypassable (Hard Rules #15 + #16)
  "/api/headroom/stop", // kills tracked PID — must never be bypassable (Hard Rules #15 + #16)
  "/api/vnc-session", // #7892: spawns Docker containers via child_process.spawn (src/lib/vncSession/service.ts) — must never be whitelistable via manage-scope bypass (Hard Rules #15 + #16)
  // LOCAL_ONLY routes that reach a spawn / code-exec sink but were never mirrored here, so
  // both enforcement layers treated them as whitelistable. Every LOCAL_ONLY prefix must now be
  // either listed here or reviewed as bypass-eligible — drift guard:
  // tests/unit/authz/local-only-bypass-spawn-denylist.test.ts (Hard Rules #15 + #16).
  "/api/middleware/", // middleware hooks compile + run caller-supplied JS via new vm.Script (src/lib/middleware/registry.ts)
  "/api/system/version", // POST auto-update spawns git checkout + npm install
  "/api/db-backups/exportAll", // spawns tar for the export archive
  "/api/db/health", // runManagedDbHealthCheck() forks native diagnostics (healthCheckRunner.ts)
  "/api/oauth/cursor/auto-import", // execFile("which", ["cursor"]) before importing creds
  "/dashboard/providers/services/", // reverse proxy into embedded service UIs — Hard Rule #16 pairs it with /api/services/
  "/api/discovery/", // not a spawn, but declared strict-loopback with no manage-scope bypass (outbound provider probes, SSRF-adjacent)
  "/api/issue-agent/", // local triage executor surface, held loopback/LAN "until sandbox + audit hardening is complete" — not opt-in remote until then
  // Host-credential reads: no spawn, but the handler reads credential files from the host's
  // home directory and imports them, so a manage-scoped key must never reach it remotely
  // either. Held to the same never-bypassable bar as the spawn routes above.
  "/api/oauth/kiro/auto-import", // reads kiro-cli data.sqlite3, ~/.aws/sso/cache and the Kiro profile.json
];

/**
 * Regex-matched companion to `SPAWN_CAPABLE_PREFIXES`, for spawn-capable
 * routes whose spawn-capable segment sits AFTER a dynamic path parameter
 * (e.g. `/api/providers/{id}/refresh-cursor`) — a flat prefix would either
 * miss them entirely or require over-broadening the shared `/api/providers/`
 * prefix (used for legitimate remote provider CRUD). Mirrors the
 * `LOCAL_ONLY_API_PREFIXES`/`LOCAL_ONLY_API_PATTERNS` split already
 * established in `routeGuard.ts` for this exact shape. Checked against a
 * CONCRETE resolved request path — an exact regex match, no approximation.
 */
export const SPAWN_CAPABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/api\/providers\/volcengine-plan\/connect(\/.*)?$/, // launches Playwright to bind a Volcano Engine console session — covers the manual headful flow AND the session-based phone/SMS auto-login sub-routes (/code, /status, /cancel, /resend)
  /^\/api\/providers\/[^/]+\/refresh-cursor\/?$/, // spawns cursor-agent via renewal.ts (Hard Rules #15 + #16)
  /^\/api\/providers\/cursor\/agent-availability\/?$/, // static path (no dynamic segment), but kept in this array alongside its /api/providers/ siblings rather than the flat SPAWN_CAPABLE_PREFIXES array — spawns cursor-agent status via checkCursorAgentAvailability()/getCachedCursorAgentAvailability() (Hard Rules #15 + #16)
  /^\/api\/providers\/agy-auth\/apply-local\/?$/, // static path kept with its /api/providers/ siblings, like cursor/agent-availability above — spawns `secret-tool` via detectLocalAgyTokenRaw() (Hard Rules #15 + #16)
  // S-01 (#15159): web-provider validation spawns `<bin> acp --agent-type summarizer`.
  // Mirrors LOCAL_ONLY_API_PATTERNS (every LOCAL_ONLY pattern must have a twin here).
  /^\/api\/providers\/(validate|import|bulk)\/?$/,
];

/**
 * Companion to `SPAWN_CAPABLE_PATTERNS`, used ONLY by the zod-level candidate
 * bypass-prefix check (`settingsSchemas.ts`), which validates a candidate
 * BYPASS PREFIX STRING (not a concrete path) at `PATCH /api/settings` time —
 * general prefix-vs-regex reachability is undecidable, so this conservatively
 * treats the shared literal ancestor of the dynamic/static-segment patterns
 * as off-limits. Intentionally coarser than `SPAWN_CAPABLE_PATTERNS`'s exact
 * per-route match, but costs nothing security-wise: the runtime check in
 * `isLocalOnlyBypassableByManageScope` (Layer 2) is the actual enforcement
 * boundary and stays exact. `SPAWN_CAPABLE_PREFIXES` itself is untouched.
 */
export const SPAWN_CAPABLE_PATTERN_ANCESTORS: ReadonlyArray<string> = ["/api/providers/"];

/**
 * Single source of truth for "may this candidate bypass prefix ever be honoured?".
 * (Covers the few non-spawn entries above too, e.g. the Kiro host-credential import.)
 * Returns true when `prefix` overlaps a spawn-capable route in EITHER direction:
 *   - it equals or sits under a spawn-capable prefix (`/api/middleware/hooks`), or
 *   - it is a parent that would cover one (`/api/`, `/api/middleware`),
 * or it overlaps a `SPAWN_CAPABLE_PATTERN_ANCESTORS` entry the same way.
 *
 * Consumed by all three enforcement points so they cannot drift apart:
 *   1. the zod refine on `localOnlyManageScopeBypassPrefixes` (settingsSchemas.ts),
 *   2. `normalizeAuthzBypass` when the runtime snapshot is loaded (runtimeSettings.ts),
 *   3. `isLocalOnlyBypassableByManageScope` on the request hot path (routeGuard.ts).
 */
export function isSpawnCapableBypassPrefix(prefix: string): boolean {
  const overlaps = (denied: string) => prefix.startsWith(denied) || denied.startsWith(prefix);
  return SPAWN_CAPABLE_PREFIXES.some(overlaps) || SPAWN_CAPABLE_PATTERN_ANCESTORS.some(overlaps);
}
