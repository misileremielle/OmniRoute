/**
 * Provider-default sliding-window rate-limit fallback (free-claude-code port, Fase 8.2).
 *
 * Providers that do NOT send rate-limit headers never let the adaptive Bottleneck path
 * in rateLimitManager learn a reservoir, so `resolveRpm` leaves them effectively
 * un-throttled. For such a provider with a *documented* fixed cap, an operator can
 * declare a default here and a sliding window (burst-free, unlike Bottleneck's
 * fixed-window reservoir which refills in one burst every interval) enforces it
 * proactively. `nvidia` is the first (and currently only) real entry — NVIDIA NIM's
 * free tier is documented as "~40 RPM" and exposes no rate-limit headers or usage
 * API (#6846 Phase 1). Every other provider still gets zero behavior change; the
 * whole path is a no-op unless an entry (or a resolved override, see below) exists.
 *
 * Composed into the rolling lease gate in `withRateLimit` (rateLimitManager.ts).
 * The exported acquire helpers remain available for provider-specific callers
 * and tests, while the main request path acquires global and provider scopes
 * atomically.
 */
import { SlidingWindowLimiter, type RateLimitWindow } from "./slidingWindowLimiter.ts";
import {
  markLocalRateLimitError,
  LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
} from "./rateLimitManager/errors.ts";

// Opt-in per-provider caps. Example shape (commented — add real entries as needed):
//   "some-headerless-provider": { requests: 60, windowMs: 60_000 },
//
// Only nvidia has a WINDOW entry. Its free tier is documented as ~40 RPM with no
// headers to read, which is a published per-minute budget nothing else in the
// request path can infer.
//
// The subscription OAuth providers deliberately do not get one: they are bounded
// by the concurrency cap above instead, and the two do the same arithmetic. With
// N slots in flight, sustained rate is N / (average response time), so a window
// only ever bites when responses come back in well under a second — it would
// queue the cheap side-queries (title, haiku-style follow-ups) while the turns
// that actually matter to a vendor's abuse heuristics are long and few. Their
// quotas are also 5-hourly/weekly, not per-minute, so a per-minute window is not
// modelling the budget the vendor enforces. Add a per-provider override from the
// resilience settings when a specific account needs one.
const PROVIDER_DEFAULT_RATE_LIMITS: Record<string, RateLimitWindow> = {
  nvidia: { requests: 40, windowMs: 60_000 },
};

/** #6846 Phase 1: default per-connection concurrency cap.
 *
 * Two groups use this table:
 *
 * - `nvidia`: static budget enforced via `open-sse/services/rateLimitSemaphore.ts`.
 *   Mid-point of the issue's suggested 4-8 range.
 * - Subscription OAuth providers (`claude`, `codex`, `agy`/`antigravity`,
 *   `copilot`, `grok-build`): without an entry a fresh connection had NO
 *   per-account cap at all — `resolveAccountSemaphoreMaxConcurrency()` returned
 *   null whenever the operator had not set `rateLimitMaxConcurrent`/
 *   `maxConcurrent`, so one account could take unbounded parallel requests. That
 *   is the shape a vendor reads as automation rather than a person at a CLI: the
 *   real binaries run one turn at a time, with an occasional small side query.
 *
 * Values are deliberately low. They only ever QUEUE (never reject), an explicit
 * `maxConcurrent` / `rateLimitMaxConcurrent` on the connection always wins, and
 * `OMNIROUTE_DEFAULT_ACCOUNT_CONCURRENCY=0` turns the whole table off.
 */
export const PROVIDER_DEFAULT_CONCURRENCY_CAP: Record<string, number> = {
  nvidia: 6,
  // One turn at a time, plus room for the harness's own small side queries.
  claude: 3,
  codex: 2,
  agy: 2,
  antigravity: 2,
  copilot: 2,
  "grok-build": 2,
};

let providerDefaultOverrides: Record<string, RateLimitWindow> | null = null;
const limiter = new SlidingWindowLimiter();

/**
 * Operator-configured overrides, resolved from `ResilienceSettings.providerQuotaOverrides`
 * (see `src/lib/resilience/settings.ts`) by `rateLimitManager.ts` on init/refresh.
 * `rpm` overrides the static sliding-window budget; `concurrency` overrides the
 * default per-connection concurrency cap. A 0/missing field falls back to the
 * static default for that field. `rateLimitCooldownSeconds` is the per-provider
 * rate-limit retry delay (see `getProviderRateLimitCooldownOverrideMs`).
 */
interface ProviderQuotaOverrideEntry {
  rpm?: number;
  concurrency?: number;
  rateLimitCooldownSeconds?: number;
}

let providerQuotaOverrides: Record<string, ProviderQuotaOverrideEntry> | null = null;

/** Test hook: override the provider-default map and clear accumulated history. */
export function __setProviderDefaultRateLimitsForTests(
  map: Record<string, RateLimitWindow> | null
): void {
  providerDefaultOverrides = map;
  limiter.reset();
}

/**
 * Set (or clear, with `null`) the operator-configured per-provider RPM/concurrency
 * overrides. Called by `rateLimitManager.ts::initializeRateLimitProtection()` and
 * `applyRequestQueueSettings()` after resolving `ResilienceSettings`.
 */
export function setProviderQuotaOverrides(
  map: Record<string, ProviderQuotaOverrideEntry> | null
): void {
  providerQuotaOverrides = map;
}

/**
 * Operator-configured per-provider rate-limit retry delay (ms), or null when unset ("Auto").
 * Consumed by `rotationConfig.ts::overrideFor` when the upstream gave no retry hint.
 */
export function getProviderRateLimitCooldownOverrideMs(provider: string): number | null {
  if (!provider) return null;
  const seconds = providerQuotaOverrides?.[provider]?.rateLimitCooldownSeconds;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : null;
}

export function getProviderDefaultRateLimit(provider: string): RateLimitWindow | undefined {
  if (!provider) return undefined;
  const rpmOverride = providerQuotaOverrides?.[provider]?.rpm;
  if (typeof rpmOverride === "number" && rpmOverride > 0) {
    return { requests: rpmOverride, windowMs: 60_000 };
  }
  return (providerDefaultOverrides ?? PROVIDER_DEFAULT_RATE_LIMITS)[provider];
}

/**
 * Resolve a provider's per-connection concurrency cap: operator override →
 * `PROVIDER_DEFAULT_CONCURRENCY_CAP[provider]` → `fallback`. Used by the nvidia
 * executor concurrency gate (`open-sse/executors/default/nvidiaConcurrencyGate.ts`).
 */
export function getProviderConcurrencyCap(provider: string, fallback: number): number {
  const override = providerQuotaOverrides?.[provider]?.concurrency;
  if (typeof override === "number" && override > 0) return override;
  const staticDefault = PROVIDER_DEFAULT_CONCURRENCY_CAP[provider];
  return typeof staticDefault === "number" && staticDefault > 0 ? staticDefault : fallback;
}

/**
 * Consume one slot from the provider's opt-in sliding-window default.
 * Returns 0 when a slot was taken (proceed) or no default is configured; otherwise the
 * ms until a slot frees, so the caller can wait and retry.
 */
export function acquireProviderDefaultSlot(provider: string, connectionId?: string | null): number {
  const cfg = getProviderDefaultRateLimit(provider);
  if (!cfg) return 0;
  const res = limiter.tryAcquire(`${provider}:${connectionId || "_"}`, cfg);
  return res.allowed ? 0 : Math.max(1, res.retryAfterMs);
}

/** Abort-aware sleep: resolves after `ms`, or rejects with AbortError if `signal` fires. */
function sleepOrAbort(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        const reason = signal.reason;
        const err =
          reason instanceof Error
            ? reason
            : new Error(typeof reason === "string" ? reason : "The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Block until the provider's opt-in sliding-window default has a free slot (or the wait
 * budget is exhausted, in which case we proceed — Bottleneck still applies). No-op when
 * the provider has no configured default. Converges: each wait frees at least one slot.
 */
export async function awaitProviderDefaultSlot(
  provider: string,
  connectionId: string | null,
  signal: AbortSignal | null,
  remainingBudgetMs?: number
): Promise<void> {
  const cfg = getProviderDefaultRateLimit(provider);
  if (!cfg) return;
  if (typeof remainingBudgetMs === "number" && remainingBudgetMs <= 0)
    throw markLocalRateLimitError(
      new Error(
        `Queue budget exhausted before provider-default slot (remaining=${remainingBudgetMs}ms)`
      ),
      LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE
    );
  const budget =
    typeof remainingBudgetMs === "number" && Number.isFinite(remainingBudgetMs)
      ? Math.min(remainingBudgetMs, cfg.windowMs)
      : Math.max(cfg.windowMs, 0);
  const start = Date.now();
  for (;;) {
    const waitMs = acquireProviderDefaultSlot(provider, connectionId);
    if (waitMs === 0) return;
    if (Date.now() - start >= budget)
      throw markLocalRateLimitError(
        new Error(`Provider-default slot wait exceeded budget ${budget}ms`),
        LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE
      );
    const remainingBudget = budget - (Date.now() - start);
    if (remainingBudget <= 0)
      throw markLocalRateLimitError(
        new Error(`Provider-default slot budget exhausted`),
        LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE
      );
    await sleepOrAbort(Math.min(waitMs, remainingBudget), signal);
  }
}
