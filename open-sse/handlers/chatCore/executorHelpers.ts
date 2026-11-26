import { FORMATS } from "../../translator/formats.ts";
import {
  buildAccountSemaphoreKey,
  buildModelSemaphoreKey,
} from "../../services/accountSemaphore.ts";
import { getProviderConcurrencyCap } from "../../services/providerDefaultRateLimit.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolveAccountSemaphoreAccountKey(
  connectionId: string | null | undefined,
  credentials: Record<string, unknown> | null | undefined
): string | null {
  if (typeof connectionId === "string" && connectionId.trim().length > 0) {
    return connectionId;
  }

  const candidateKeys = [
    credentials?.connectionId,
    credentials?.id,
    credentials?.email,
    credentials?.name,
    credentials?.displayName,
  ];

  for (const candidate of candidateKeys) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Global escape hatch for the built-in per-account caps: `0` disables them, a
 * positive number replaces every provider default. An explicit per-connection
 * value still wins over both.
 */
const DEFAULT_ACCOUNT_CONCURRENCY_ENV = "OMNIROUTE_DEFAULT_ACCOUNT_CONCURRENCY";

function resolveDefaultAccountConcurrency(provider: string | null | undefined): number | null {
  const rawEnv = process.env[DEFAULT_ACCOUNT_CONCURRENCY_ENV];
  if (rawEnv !== undefined && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed)) {
      return parsed > 0 ? parsed : null;
    }
  }
  if (!provider) return null;
  const cap = getProviderConcurrencyCap(provider, 0);
  return cap > 0 ? cap : null;
}

/**
 * Effective per-account concurrency cap for one execution attempt.
 *
 * Precedence: `rateLimitMaxConcurrent` (while rate-limit protection is on) →
 * `maxConcurrent` (an explicit 0 means "unlimited", so it still wins) →
 * `OMNIROUTE_DEFAULT_ACCOUNT_CONCURRENCY` → the provider's built-in default →
 * no gate.
 *
 * The built-in default matters for ban risk: an OAuth-subscription account with
 * no configured cap previously took unbounded parallel requests, which is a
 * traffic shape no single CLI produces.
 */
export function resolveAccountSemaphoreMaxConcurrency(
  credentials: Record<string, unknown> | null | undefined,
  rateLimitProtectionEnabled = true,
  provider?: string | null
): number | null {
  const rateLimitOverride = toFiniteNumberOrNull(credentials?.rateLimitMaxConcurrent);
  if (rateLimitProtectionEnabled && rateLimitOverride !== null && rateLimitOverride > 0) {
    return rateLimitOverride;
  }
  const explicit = toFiniteNumberOrNull(credentials?.maxConcurrent);
  if (explicit !== null) return explicit;
  if (!rateLimitProtectionEnabled) return null;
  return resolveDefaultAccountConcurrency(provider);
}

/**
 * Resolve the per-model concurrency cap for one execution attempt.
 *
 * Exact-match on the model string passed to the executor after routing
 * resolution (normally the bare upstream model id, e.g. "glm-5" — not a
 * client-side `provider/model` alias). Missing credentials, a missing or
 * malformed map, or a non-positive cap all resolve to null ("no model
 * gate") so an unconfigured or corrupt map never blocks a request.
 */
export function resolveModelSemaphoreMaxConcurrency(
  credentials: Record<string, unknown> | null | undefined,
  model: string | null | undefined
): number | null {
  if (!model || typeof model !== "string" || model.trim().length === 0) return null;
  const map = credentials?.modelConcurrency;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const cap = toFiniteNumberOrNull((map as Record<string, unknown>)[model]);
  if (cap == null || !Number.isInteger(cap) || cap < 1) return null;
  return cap;
}

export function resolveAccountSemaphoreKey({
  provider,
  model,
  connectionId,
  credentials,
}: {
  provider: string | null | undefined;
  model: string;
  connectionId: string | null | undefined;
  credentials: Record<string, unknown> | null | undefined;
}): string | null {
  const accountKey = resolveAccountSemaphoreAccountKey(connectionId, credentials);
  if (!accountKey || !provider) return null;
  return buildAccountSemaphoreKey({ provider, accountKey });
}

/**
 * Build the per-connection, per-model semaphore key for one execution
 * attempt. Returns null when no positive cap is configured for
 * `provider + connection + model`, in which case the caller must not add a
 * model requirement to the composite gate (behavior unchanged).
 */
export function resolveModelSemaphoreKey({
  provider,
  model,
  connectionId,
  credentials,
}: {
  provider: string | null | undefined;
  model: string;
  connectionId: string | null | undefined;
  credentials: Record<string, unknown> | null | undefined;
}): string | null {
  const accountKey = resolveAccountSemaphoreAccountKey(connectionId, credentials);
  if (!accountKey || !provider) return null;
  if (resolveModelSemaphoreMaxConcurrency(credentials, model) == null) return null;
  return buildModelSemaphoreKey({ provider, accountKey, model });
}

/** Per-model gate (key + cap) for the composite semaphore; key null = no gate. */
export function resolveModelSemaphore(args: {
  provider: string | null | undefined;
  model: string;
  connectionId: string | null | undefined;
  credentials: Record<string, unknown> | null | undefined;
}): { key: string | null; maxConcurrency: number | null } {
  return {
    key: resolveModelSemaphoreKey(args),
    maxConcurrency: resolveModelSemaphoreMaxConcurrency(args.credentials, args.model),
  };
}

export function buildClaudePromptCacheLogMeta(
  targetFormat: string,
  finalBody: Record<string, unknown> | null | undefined,
  providerHeaders: Record<string, unknown> | Headers | null | undefined,
  clientHeaders?: Headers | Record<string, unknown> | null | undefined
) {
  if (targetFormat !== FORMATS.CLAUDE || !finalBody || typeof finalBody !== "object") return null;

  const describeCacheControl = (cacheControl: Record<string, unknown> | undefined, extra = {}) => ({
    type:
      cacheControl && typeof cacheControl.type === "string" && cacheControl.type.trim()
        ? cacheControl.type.trim()
        : "ephemeral",
    ttl:
      cacheControl && typeof cacheControl.ttl === "string" && cacheControl.ttl.trim()
        ? cacheControl.ttl.trim()
        : null,
    ...extra,
  });

  const systemBreakpoints = Array.isArray(finalBody.system)
    ? finalBody.system.flatMap((block, index) => {
        if (!block || typeof block !== "object") return [];
        const text =
          typeof block.text === "string" && block.text.trim().length > 0 ? block.text.trim() : "";
        if (text.startsWith("x-anthropic-billing-header:")) {
          return [];
        }
        const cacheControl =
          block.cache_control && typeof block.cache_control === "object"
            ? block.cache_control
            : null;
        return cacheControl ? [describeCacheControl(cacheControl, { index })] : [];
      })
    : [];

  const toolBreakpoints = Array.isArray(finalBody.tools)
    ? finalBody.tools.flatMap((tool, index) => {
        if (!tool || typeof tool !== "object") return [];
        const cacheControl =
          tool.cache_control && typeof tool.cache_control === "object" ? tool.cache_control : null;
        const name = typeof tool.name === "string" && tool.name.trim() ? tool.name.trim() : null;
        return cacheControl ? [describeCacheControl(cacheControl, { index, name })] : [];
      })
    : [];

  const messageBreakpoints = Array.isArray(finalBody.messages)
    ? finalBody.messages.flatMap((message, messageIndex) => {
        if (!message || typeof message !== "object" || !Array.isArray(message.content)) return [];
        const role =
          typeof message.role === "string" && message.role.trim() ? message.role.trim() : "unknown";
        return message.content.flatMap((block, contentIndex) => {
          if (!block || typeof block !== "object") return [];
          const cacheControl =
            block.cache_control && typeof block.cache_control === "object"
              ? block.cache_control
              : null;
          if (!cacheControl) return [];
          return [
            describeCacheControl(cacheControl, {
              messageIndex,
              contentIndex,
              role,
              blockType:
                typeof block.type === "string" && block.type.trim() ? block.type.trim() : "unknown",
            }),
          ];
        });
      })
    : [];

  const totalBreakpoints =
    systemBreakpoints.length + toolBreakpoints.length + messageBreakpoints.length;
  let anthropicBeta = getHeaderValueCaseInsensitive(providerHeaders, "Anthropic-Beta");
  if (!anthropicBeta) {
    anthropicBeta = getHeaderValueCaseInsensitive(clientHeaders, "Anthropic-Beta");
  }

  if (totalBreakpoints === 0 && !anthropicBeta) return null;

  return {
    applied: totalBreakpoints > 0,
    totalBreakpoints,
    anthropicBeta,
    systemBreakpoints,
    toolBreakpoints,
    messageBreakpoints,
  };
}
