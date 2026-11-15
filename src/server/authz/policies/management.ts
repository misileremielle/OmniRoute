import { createHash, timingSafeEqual } from "node:crypto";
import { isModelSyncInternalRequest } from "../../../shared/services/modelSyncScheduler";
import { isAuthRequired, isDashboardSessionAuthenticated } from "../../../shared/utils/apiAuth";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";
import { extractApiKey, isValidApiKey } from "../../../sse/services/auth";
import { getApiKeyMetadata } from "../../../lib/db/apiKeys";
import { hasManageScope } from "../../../lib/api/requireManagementAuth";
import { evaluateAccessTokenAuth } from "../accessTokenAuth";
import { isInternalServiceRequest } from "../../../lib/api/internalServiceAuth";
import {
  hasValidLoopbackCliToken,
  isLoopbackRequest,
  isPrivateLanRequest,
  LOCAL_CLI_SUBJECT,
} from "../peerContext";
import {
  isAlwaysProtectedPath,
  isLocalOnlyBypassableByManageScope,
  isLocalOnlyPath,
} from "../routeGuard";

const MODEL_SYNC_MANAGEMENT_PATH = /^\/api\/providers\/[^/]+\/(sync-models|models)$/;

function hasBearerToken(headers: Headers): boolean {
  const authHeader = headers.get("authorization") ?? headers.get("Authorization");
  return typeof authHeader === "string" && authHeader.trim().toLowerCase().startsWith("bearer ");
}

function isInternalModelSyncRequest(ctx: PolicyContext): boolean {
  if (!MODEL_SYNC_MANAGEMENT_PATH.test(ctx.classification.normalizedPath)) return false;
  return isModelSyncInternalRequest(ctx.request);
}

const WS_BRIDGE_INTERNAL_PATH = "/api/internal/codex-responses-ws";
const WS_BRIDGE_SECRET_HEADER = "x-omniroute-ws-bridge-secret";

// The in-process codex Responses-over-WebSocket proxy authenticates its internal
// authenticate/prepare calls with a per-process, unguessable secret minted by
// server-ws.mjs (OMNIROUTE_WS_BRIDGE_SECRET). Without this carve-out the MANAGEMENT
// classification 401s that loopback call, which then leaks chunked/security headers
// back onto the upgrade socket. The internal route re-validates the secret timing-safe
// (bridgeSecretMatches), so this is the same trust boundary, surfaced one layer up.
function isValidWsBridgeRequest(ctx: PolicyContext): boolean {
  if (ctx.classification.normalizedPath !== WS_BRIDGE_INTERNAL_PATH) return false;
  const expected = process.env.OMNIROUTE_WS_BRIDGE_SECRET || "";
  if (!expected) return false;
  const provided = ctx.request.headers?.get?.(WS_BRIDGE_SECRET_HEADER) ?? "";
  if (!provided) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

export const managementPolicy: RoutePolicy = {
  routeClass: "MANAGEMENT",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const path = ctx.classification.normalizedPath;

    // Codex Responses-over-WS bridge: honor the per-process bridge secret before
    // the loopback/auth gates so the proxy's internal calls aren't 401'd (which
    // would corrupt the WS upgrade response). The internal route re-checks it.
    if (isValidWsBridgeRequest(ctx)) {
      return allow({ kind: "management_key", id: "ws-bridge", label: "codex-ws-bridge-secret" });
    }

    // Tier 1: local-only gate — block spawn-capable routes from non-loopback.
    //
    // Carve-out: a small allow-list of LOCAL_ONLY paths (see
    // LOCAL_ONLY_MANAGE_SCOPE_BYPASS_PREFIXES) is reachable from non-loopback
    // when the caller presents EITHER (a) a valid API key with the `manage`
    // scope, or (b) an authenticated dashboard session. The list is empty by
    // default; operators can extend it in settings.
    //
    // The strict-loopback default still applies to everything else (notably
    // the subprocess-spawning /api/services/* surface, which is NOT
    // in the bypass list).
    //
    // Anonymous (no Bearer / invalid key / wrong scope / no session) requests
    // still hit the same 403 LOCAL_ONLY they did before.
    if (
      isLocalOnlyPath(path, ctx.request?.method) &&
      !isLoopbackRequest(ctx) &&
      !isPrivateLanRequest(ctx)
    ) {
      if (isLocalOnlyBypassableByManageScope(path)) {
        // Management auth is header-only — a URL-borne token must never satisfy a
        // manage-scope bypass of a LOCAL_ONLY route. See #3300 follow-up.
        const apiKey = extractApiKey(ctx.request as unknown as Request);
        if (apiKey) {
          try {
            if (await isValidApiKey(apiKey)) {
              const meta = await getApiKeyMetadata(apiKey);
              if (meta && hasManageScope(meta.scopes)) {
                // Distinguish admin vs manage in the audit label so log review
                // can tell which privilege actually granted the bypass.
                const grantedBy = meta.scopes.includes("admin") ? "admin" : "manage";
                return allow({
                  kind: "management_key",
                  id: meta.id,
                  label: `api-key-${grantedBy}-scope-local-only-bypass`,
                });
              }
            }
          } catch (err) {
            // Auth backend (DB / file store) failure: surface as 503 so the
            // caller can retry. Anything else (TypeError / ReferenceError /
            // programmer error) is logged so it's not silently swallowed —
            // the policy still degrades closed (503) to avoid leaking the
            // route, but we leave a breadcrumb for ops.
            console.error("[managementPolicy] manage-scope bypass auth check failed", err);
            return reject(503, "AUTH_BACKEND_UNAVAILABLE", "Service temporarily unavailable");
          }
        }
        // Dashboard session bypass: cookie auth is already proof of an
        // authenticated admin — same trust level as a manage-scope Bearer for
        // the surface in scope here.
        try {
          if (await isDashboardSessionAuthenticated(ctx.request)) {
            return allow({
              kind: "dashboard_session",
              id: "dashboard",
              label: "dashboard-session-local-only-bypass",
            });
          }
        } catch (err) {
          // Mirror the manage-scope branch above: degrade closed (503) rather
          // than leaking the route through an unhandled 500, but log a
          // breadcrumb for ops. Session-store DB failure / cookie parsing
          // error / JWT decode throw all land here.
          console.error("[managementPolicy] dashboard-session bypass auth check failed", err);
          return reject(503, "AUTH_BACKEND_UNAVAILABLE", "Service temporarily unavailable");
        }
      }
      return reject(403, "LOCAL_ONLY", "This endpoint requires localhost access");
    }

    if (isInternalModelSyncRequest(ctx)) {
      return allow({ kind: "management_key", id: "model-sync", label: "internal-model-sync" });
    }

    if (isLoopbackRequest(ctx) && isInternalServiceRequest(ctx.request as unknown as Request)) {
      return allow({
        kind: "management_key",
        id: "internal-service",
        label: "internal-service-token",
      });
    }

    if (hasValidLoopbackCliToken(ctx)) {
      return allow({ ...LOCAL_CLI_SUBJECT });
    }

    // Tier 2: always-protected routes skip the requireLogin=false bypass.
    //
    // The fresh-install bootstrap branch inside isAuthRequired() is loopback-only.
    // Hand it the SAME trusted verdict the LOCAL_ONLY gate above used (token-stamped
    // real TCP peer via peerContext) instead of letting it sniff ctx.request — the
    // ORIGINAL request still carries every client-supplied header at this point,
    // and the Host header was how a remote caller reached the anonymous
    // POST /api/settings/require-login write (GHSA-7pq4-8pvv-rx7r).
    if (
      !isAlwaysProtectedPath(path) &&
      !(await isAuthRequired(ctx.request, { loopback: isLoopbackRequest(ctx) }))
    ) {
      return allow({ kind: "anonymous", id: "anonymous", label: "auth-disabled" });
    }

    if (await isDashboardSessionAuthenticated(ctx.request)) {
      return allow({ kind: "dashboard_session", id: "dashboard" });
    }

    // Allow API keys with the `manage` scope — enables headless / programmatic
    // management (e.g. provisioning providers, setting rate limits) without
    // a browser session. The pieces below already exist and are used by
    // `requireManagementAuth` on individual routes; wiring them here closes
    // the gap so management auth is consistent across the policy layer.
    //
    // Error handling mirrors `requireManagementAuth.ts`: a thrown
    // isValidApiKey / getApiKeyMetadata indicates the auth backend is
    // unhealthy, which is a 503, not a 403 — masking it as an auth failure
    // would tell callers their credentials are wrong when the real problem
    // is that the server cannot validate any credential right now.
    // Scoped CLI access token (remote mode). Evaluated BEFORE the API-key branch
    // because `oma_` tokens are management credentials, not inference API keys.
    // Shared with `requireManagementAuth` (no drift). Scope enforced per the
    // method+admin-allowlist policy (inferRequiredScope).
    const accessVerdict = evaluateAccessTokenAuth(ctx.request as unknown as Request);
    switch (accessVerdict.kind) {
      case "ok":
        return allow({
          kind: "management_key",
          id: accessVerdict.id,
          label: `access-token:${accessVerdict.scope}`,
        });
      case "error":
        return reject(503, "AUTH_BACKEND_UNAVAILABLE", "Service temporarily unavailable");
      case "invalid":
        return reject(401, "AUTH_001", "Invalid or expired access token");
      case "insufficient":
        return reject(
          403,
          "AUTH_SCOPE",
          `Access token scope '${accessVerdict.have}' is insufficient; '${accessVerdict.need}' required.`
        );
      case "absent":
        break; // no oma_ token → fall through to API-key auth
    }

    // Management auth is header-only — a URL-borne token must not authenticate
    // a management route. See #3300 follow-up.
    const apiKey = extractApiKey(ctx.request as unknown as Request);
    if (apiKey) {
      try {
        if (await isValidApiKey(apiKey)) {
          const meta = await getApiKeyMetadata(apiKey);
          // getApiKeyMetadata returns null whenever the row has no id,
          // so when `meta` is truthy `meta.id` is guaranteed non-empty.
          if (meta && hasManageScope(meta.scopes)) {
            return allow({
              kind: "management_key",
              id: meta.id,
              label: "api-key-manage-scope",
            });
          }
        }
      } catch {
        return reject(503, "AUTH_BACKEND_UNAVAILABLE", "Service temporarily unavailable");
      }
    }

    const bearerPresent = hasBearerToken(ctx.request.headers);
    return reject(
      bearerPresent ? 403 : 401,
      "AUTH_001",
      bearerPresent ? "Invalid management token" : "Authentication required"
    );
  },
};
