import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

/**
 * Why `apiKeyId` is null — the lifecycle outcome `getApiKeyRequestScope` already
 * computed, surfaced so a route can name it in an audit line WITHOUT re-running
 * the gate (omni-code-review LEDGER-3/9):
 *
 *   - `none`       — no key presented (anonymous or session-only caller);
 *   - `unresolved` — a key was presented but no row matches (deleted, rotated, mistyped);
 *   - `invalid`    — the row exists but failed `validateApiKey`
 *                    (is_active / revoked_at / is_banned / expires_at);
 *   - `valid`      — passed the gate; `apiKeyId` and `apiKeyMetadata` are set.
 *
 * `apiKeyId !== null` ⟺ `keyState === "valid"`. Additive field: every consumer
 * that only reads `apiKeyId` keeps working unchanged.
 */
export type ApiKeyState = "none" | "unresolved" | "invalid" | "valid";

export interface ApiKeyRequestScope {
  apiKey: string | null;
  apiKeyId: string | null;
  apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  keyState: ApiKeyState;
  rejection: Response | null;
  isSessionAuth: boolean;
}

export async function getApiKeyRequestScope(request: Request): Promise<ApiKeyRequestScope> {
  const isSessionAuth = await isDashboardSessionAuthenticated(request);
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return {
      apiKey: null,
      apiKeyId: null,
      apiKeyMetadata: null,
      keyState: "none",
      rejection: null,
      isSessionAuth,
    };
  }

  const apiKeyMetadata = await getApiKeyMetadata(apiKey);

  // Fail closed: `getApiKeyMetadata` resolves the key by row EXISTENCE only —
  // it applies no lifecycle filter. `validateApiKey` is the one gate that
  // checks is_active/revoked_at/is_banned/expires_at (CWE-613). A key that
  // fails that gate is folded into the same `{ apiKeyId: null }` shape as an
  // unresolved/anonymous caller, so every consumer of this scope treats a
  // revoked/expired/banned key as invalid without each caller re-implementing
  // the check — this is the single lifecycle gate; callers must not re-run it.
  let keyState: ApiKeyState = "unresolved";
  if (apiKeyMetadata) keyState = (await validateApiKey(apiKey)) ? "valid" : "invalid";
  if (keyState !== "valid") {
    return {
      apiKey,
      apiKeyId: null,
      apiKeyMetadata: null,
      keyState,
      rejection: null,
      isSessionAuth,
    };
  }
  return {
    apiKey,
    apiKeyId: apiKeyMetadata.id,
    apiKeyMetadata,
    keyState,
    rejection: null,
    isSessionAuth,
  };
}
