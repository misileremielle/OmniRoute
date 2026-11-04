/**
 * Multi-credential client API key resolution.
 *
 * Clients can present an unrelated `Authorization: Bearer …` header ALONGSIDE a
 * valid OmniRoute key — e.g. Claude Code with an active claude.ai session or
 * `ANTHROPIC_AUTH_TOKEN` set sends its own Bearer next to `x-api-key`, and
 * api.anthropic.com still authenticates on `x-api-key`. Auth therefore has to
 * consider every presented credential, and identity / policy / usage must bind
 * to the one that actually validated, never to the stale Bearer.
 *
 * `extractApiKey()` in `./auth.ts` keeps its Bearer-first, single-credential
 * contract untouched (management auth and many identity readers depend on it).
 * Lives in its own module so the frozen `auth.ts` does not grow
 * (`config/quality/file-size-baseline.json`).
 *
 * @module sse/services/clientApiKeyResolver
 */

import { extractApiKey, isValidApiKey } from "./auth.ts";
import { extractGoogApiKeyHeader } from "./googApiKeyAuth.ts";
import { readHeaderValue, type AuthRequestHeaders } from "./headerReader.ts";

type ClientAuthRequestLike = {
  headers?: AuthRequestHeaders | null;
};

export type ResolvedClientApiKey = { apiKey: string | null; valid: boolean };

/**
 * Every client credential the request presents, in precedence order and
 * deduplicated: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`.
 * At most 3 candidates.
 *
 * Unlike `extractApiKey()`, the `x-api-key` candidate is NOT gated on
 * `anthropic-version` (#2225): a candidate only becomes an identity after it
 * validates, so placeholder values sent by local-mode clients are just skipped.
 */
export function extractApiKeyCandidates(request: ClientAuthRequestLike): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length > 0 && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const authHeader =
    readHeaderValue(request?.headers, "Authorization") ||
    readHeaderValue(request?.headers, "authorization");
  if (typeof authHeader === "string") {
    const trimmedHeader = authHeader.trim();
    if (trimmedHeader.toLowerCase().startsWith("bearer ")) push(trimmedHeader.slice(7));
  }
  push(
    readHeaderValue(request?.headers, "x-api-key") || readHeaderValue(request?.headers, "X-Api-Key")
  );
  push(extractGoogApiKeyHeader(request?.headers));

  return candidates;
}

/**
 * Resolve the client's API key across every presented credential.
 *
 * Returns `{ apiKey, valid: true }` with the FIRST candidate (precedence order of
 * `extractApiKeyCandidates()`) that passes `isValidApiKey()` — use it for key
 * identity, policy and usage attribution. When nothing validates, returns
 * `{ apiKey: extractApiKey(request), valid: false }`, so the invalid path
 * keeps the legacy Bearer-first identity byte-for-byte and an unvalidated,
 * ungated `x-api-key` never surfaces as an identity.
 */
export async function resolveClientApiKey(
  request: ClientAuthRequestLike
): Promise<ResolvedClientApiKey> {
  for (const candidate of extractApiKeyCandidates(request)) {
    if (await isValidApiKey(candidate)) return { apiKey: candidate, valid: true };
  }
  return { apiKey: extractApiKey(request), valid: false };
}
