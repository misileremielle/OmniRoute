/**
 * grokQuotaFetcher.ts — xAI shared weekly billing helpers.
 *
 * `fetchGrokBillingWithToken` / `grokBillingSnapshotToQuotaInfo` call the billing API that
 * powers the grok CLI /usage command and map it to the preflight QuotaInfo contract. Used by
 * `xaiOauthQuotaFetcher.ts` (connection OAuth token path).
 *
 * The billing endpoint returns a single weekly credit-usage percentage that covers all Grok
 * products (Chat, Build, Imagine, API) under the SuperGrok / X Premium+ unified weekly pool.
 */

import { type QuotaInfo } from "./quotaPreflight.ts";
import { fetchWithConnectionProxy } from "./connectionProxyFetch.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Stable window identifier for the weekly quota.
 * Surfaced in the dashboard as "Weekly" under provider limits.
 */
export const GROK_WINDOW_WEEKLY = "weekly";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BillingConfig {
  currentPeriod?: {
    type?: string;
    start?: string;
    end?: string;
  };
  creditUsagePercent?: number;
  onDemandCap?: { val?: number };
  onDemandUsed?: { val?: number };
  prepaidBalance?: { val?: number };
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
  isUnifiedBillingUser?: boolean;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
}

interface BillingResponse {
  config?: BillingConfig;
}

interface UsageSnapshot {
  percent: number;
  periodLabel: string;
  resetLabel: string;
  endIso?: string;
  email?: string;
  products: Array<{ product: string; usagePercent?: number }>;
  onDemandUsed: number;
  onDemandCap: number;
  prepaidBalance: number;
  fetchedAt: number;
}

/** Public billing snapshot for the shared weekly credit pool (xai-oauth). */
export type GrokBillingSnapshot = UsageSnapshot;

// ─── Billing fetch ───────────────────────────────────────────────────────────

function periodShort(type?: string): string {
  if (!type) return "";
  if (type.includes("WEEKLY")) return "weekly";
  if (type.includes("MONTHLY")) return "monthly";
  if (type.includes("DAILY")) return "daily";
  return "period";
}

function resetLocalLabel(endIso?: string): string {
  if (!endIso) return "";
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return "";
  const weekday = end.toLocaleDateString(undefined, { weekday: "short" });
  const hour = end.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${weekday} ${hour.replace(/^24:/, "00:")}`;
}

/**
 * Call xAI's shared weekly billing endpoint with an already-resolved Bearer token.
 * Used by xai-oauth (connection access token).
 *
 * Endpoint: GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * `creditUsagePercent` is percent **used** (0–100), matching grok.com Usage UI.
 */
export async function fetchGrokBillingWithToken(
  token: string,
  signal: AbortSignal | undefined,
  connectionId: string
): Promise<GrokBillingSnapshot> {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    return await fetchBilling(token, signal ?? controller!.signal, connectionId);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Convert a billing snapshot into the preflight QuotaInfo contract.
 * Single weekly window; percentUsed = creditUsagePercent / 100.
 */
export function grokBillingSnapshotToQuotaInfo(snap: GrokBillingSnapshot): QuotaInfo {
  return snapshotToQuotaInfo(snap);
}

async function fetchBilling(
  token: string,
  signal: AbortSignal,
  connectionId: string
): Promise<UsageSnapshot> {
  const res = await fetchWithConnectionProxy(connectionId, BILLING_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "omniroute-grok-usage/1.0",
      "x-grok-client-mode": "cli",
    },
    signal,
  });
  if (!res) throw new Error("proxy quota fetch failed");

  if (res.status === 401 || res.status === 403) {
    throw new Error(`auth ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as BillingResponse;
  const cfg = data.config ?? {};
  const percent = Number(cfg.creditUsagePercent ?? 0);
  const endIso = cfg.currentPeriod?.end ?? cfg.billingPeriodEnd;
  const products = (cfg.productUsage ?? [])
    .filter((p) => p.product)
    .map((p) => ({ product: String(p.product), usagePercent: p.usagePercent }));

  return {
    percent: Number.isFinite(percent) ? percent : 0,
    periodLabel: periodShort(cfg.currentPeriod?.type),
    resetLabel: resetLocalLabel(endIso),
    endIso,
    products,
    onDemandUsed: Number(cfg.onDemandUsed?.val ?? 0),
    onDemandCap: Number(cfg.onDemandCap?.val ?? 0),
    prepaidBalance: Number(cfg.prepaidBalance?.val ?? 0),
    fetchedAt: Date.now(),
  };
}

// ─── Core Fetcher ────────────────────────────────────────────────────────────

/**
 * Convert a UsageSnapshot into the preflight QuotaInfo contract.
 * Grok has a single weekly window; percentUsed = creditUsagePercent / 100.
 * The resetAt comes from currentPeriod.end.
 */
function snapshotToQuotaInfo(snap: UsageSnapshot): QuotaInfo {
  const percentUsed = Math.max(0, Math.min(1, snap.percent / 100));
  return {
    used: Math.round(snap.percent),
    total: 100,
    percentUsed,
    resetAt: snap.endIso ?? null,
    windows: {
      [GROK_WINDOW_WEEKLY]: {
        percentUsed,
        resetAt: snap.endIso ?? null,
      },
    },
  };
}
