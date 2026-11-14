import { normalizeProviderSpecificData } from "@/lib/providers/requestDefaults";
import { ensureCodexFingerprintSeed } from "@omniroute/open-sse/config/codexIdentity.ts";

type Metadata = Record<string, unknown>;

function isMetadata(value: unknown): value is Metadata {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** OAuth refreshes cannot reset operator quota controls they do not supply. */
export function normalizeConnectionProviderSpecificData(
  provider: string | null,
  providerSpecificData: unknown,
  credentials: { accessToken?: unknown; refreshToken?: unknown },
  existingProviderSpecificData?: unknown
) {
  const normalized = normalizeProviderSpecificData(provider, providerSpecificData);
  const withExpiry = normalized as Metadata;
  if (provider !== "codex") return withExpiry;

  if (isMetadata(providerSpecificData) && isMetadata(existingProviderSpecificData)) {
    // Operator controls a fresh OAuth payload never carries: keep them across re-login.
    for (const key of ["limitPolicy", "quotaPreflightEnabled", "allowPaidCredits"] as const) {
      if (
        !Object.hasOwn(providerSpecificData, key) &&
        Object.hasOwn(existingProviderSpecificData, key)
      ) {
        withExpiry[key] = existingProviderSpecificData[key];
      }
    }
  }
  return ensureCodexFingerprintSeed(
    withExpiry,
    credentials,
    (existingProviderSpecificData as Metadata | null) ?? null
  );
}
