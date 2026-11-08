/**
 * E2E Test Suite — OmniRoute Ecosystem
 *
 * Scenarios covering MCP, quota, Auto-Combo, OpenClaw, Stress, and Security.
 * Run with: npm run test:ecosystem
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.OMNIROUTE_BASE_URL || "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY || "";
const REQUEST_TIMEOUT_MS = Number(process.env.ECOSYSTEM_REQUEST_TIMEOUT_MS || 30000);
const TEST_TIMEOUT_MS = Number(process.env.ECOSYSTEM_TEST_TIMEOUT_MS || 30000);
const STRESS_TIMEOUT_MS = Number(process.env.ECOSYSTEM_STRESS_TIMEOUT_MS || 45000);

function itCase(name: string, fn: () => Promise<void> | void) {
  return it(name, fn, TEST_TIMEOUT_MS);
}

function itStress(name: string, fn: () => Promise<void> | void) {
  return it(name, fn, STRESS_TIMEOUT_MS);
}

async function apiFetch(path: string, options?: RequestInit) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      ...(options?.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// ─── Scenario 1: MCP Server Complete ─────────────────────────────
describe("E2E: MCP Server (16 tools)", () => {
  itCase("should respond to health check", async () => {
    const res = await apiFetch("/api/monitoring/health");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data).toHaveProperty("status");
  });

  itCase("should list combos", async () => {
    const res = await apiFetch("/api/combos");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(Array.isArray(data?.combos)).toBe(true);
  });

  itCase("should return quota data", async () => {
    const res = await apiFetch("/api/usage/quota");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(Array.isArray(data?.providers)).toBe(true);
    expect(data).toHaveProperty("meta");
  });

  itCase("should return usage analytics", async () => {
    const res = await apiFetch("/api/usage/analytics?period=session");
    expect(res.ok).toBe(true);
  });

  itCase("should return model catalog", async () => {
    const res = await apiFetch("/api/models");
    expect(res.ok).toBe(true);
  });
});

// ─── Scenario 1B: Quota Contract ─────────────────────────────
describe("E2E: Quota Contract (/api/usage/quota)", () => {
  itCase("should return normalized quota response shape", async () => {
    const res = await apiFetch("/api/usage/quota");
    expect(res.ok).toBe(true);

    const data = (await res.json()) as any;
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data).toHaveProperty("meta");
    expect(typeof data.meta.generatedAt).toBe("string");
    expect(typeof data.meta.totalProviders).toBe("number");

    if (data.providers.length > 0) {
      const p = data.providers[0];
      expect(typeof p.name).toBe("string");
      expect(typeof p.provider).toBe("string");
      expect(typeof p.connectionId).toBe("string");
      expect(typeof p.quotaUsed).toBe("number");
      expect(typeof p.percentRemaining).toBe("number");
      expect(p.percentRemaining).toBeGreaterThanOrEqual(0);
      expect(p.percentRemaining).toBeLessThanOrEqual(100);
      expect(["valid", "expiring", "expired", "refreshing"]).toContain(p.tokenStatus);
    }
  });

  itCase("should filter quota by provider", async () => {
    const allRes = await apiFetch("/api/usage/quota");
    expect(allRes.ok).toBe(true);
    const allData = (await allRes.json()) as any;
    if (!Array.isArray(allData.providers) || allData.providers.length === 0) return;

    const provider = allData.providers[0].provider;
    const filteredRes = await apiFetch(`/api/usage/quota?provider=${encodeURIComponent(provider)}`);
    expect(filteredRes.ok).toBe(true);
    const filteredData = (await filteredRes.json()) as any;
    expect(filteredData.meta.filters.provider).toBe(provider);
    expect(Array.isArray(filteredData.providers)).toBe(true);
    expect(filteredData.providers.every((p: any) => p.provider === provider)).toBe(true);
  });

  itCase("should filter quota by connectionId", async () => {
    const allRes = await apiFetch("/api/usage/quota");
    expect(allRes.ok).toBe(true);
    const allData = (await allRes.json()) as any;
    if (!Array.isArray(allData.providers) || allData.providers.length === 0) return;

    const connectionId = allData.providers[0].connectionId;
    const filteredRes = await apiFetch(
      `/api/usage/quota?connectionId=${encodeURIComponent(connectionId)}`
    );
    expect(filteredRes.ok).toBe(true);
    const filteredData = (await filteredRes.json()) as any;
    expect(filteredData.meta.filters.connectionId).toBe(connectionId);
    expect(Array.isArray(filteredData.providers)).toBe(true);
    expect(filteredData.providers.every((p: any) => p.connectionId === connectionId)).toBe(true);
  });
});

// ─── Scenario 3: Auto-Combo ─────────────────────────────────────
describe("E2E: Auto-Combo (routing + self-healing)", () => {
  itCase("should create auto-combo", async () => {
    const res = await apiFetch("/api/combos", {
      method: "POST",
      body: JSON.stringify({
        name: `e2e-auto-test-${Date.now()}`,
        strategy: "auto",
        models: [{ model: "gpt-4" }],
        config: {
          candidatePool: ["anthropic", "google"],
          modePack: "ship-fast",
        },
      }),
    });
    if (!res.ok) console.error("POST /api/combos failed:", await res.text());
    expect(res.ok).toBe(true);
  });

  itCase("should list auto-combos", async () => {
    const res = await apiFetch("/api/combos");
    if (!res.ok) console.error("GET /api/combos failed:", await res.text());
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(Array.isArray(data?.combos)).toBe(true);
    const autoCombos = data.combos.filter((c: any) => c.strategy === "auto");
    expect(autoCombos.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── Scenario 4: OpenClaw Integration ────────────────────────────
describe("E2E: OpenClaw Integration", () => {
  itCase("should return dynamic provider.order", async () => {
    const res = await apiFetch("/api/cli-tools/openclaw/auto-order");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data).toHaveProperty("provider");
    expect(data.provider).toHaveProperty("order");
    expect(Array.isArray(data.provider.order)).toBe(true);
    expect(data.provider).toHaveProperty("allow_fallbacks");
    expect(data).toHaveProperty("source");
  });
});

// ─── Scenario 5: Stress Test ─────────────────────────────────────
describe("E2E: Stress (100 parallel requests)", () => {
  itStress("should handle 100 health checks in <10s", async () => {
    const start = Date.now();
    const promises = Array.from({ length: 100 }, (_, i) =>
      apiFetch("/api/monitoring/health").then((r) => ({
        ok: r.ok,
        index: i,
      }))
    );
    const results = await Promise.allSettled(promises);
    const elapsed = Date.now() - start;

    const successful = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;

    expect(successful).toBeGreaterThanOrEqual(90); // allow 10% failure
    expect(elapsed).toBeLessThan(10_000);
  });

  itStress("should handle 50 parallel quota checks", async () => {
    const promises = Array.from({ length: 50 }, () =>
      apiFetch("/api/usage/quota").then((r) => r.ok)
    );
    const results = await Promise.allSettled(promises);
    const successful = results.filter((r) => r.status === "fulfilled" && r.value).length;
    expect(successful).toBeGreaterThanOrEqual(40);
  });
});

// ─── Scenario 6: Security ────────────────────────────────────────
describe("E2E: Security", () => {
  itCase("should not expose internal errors in API responses", async () => {
    const res = await apiFetch("/api/monitoring/health", {
      method: "PATCH",
    });
    // Should return method error without leaking server internals
    expect(res.status).toBe(405);
    const body = await res.text();
    expect(body.includes("Error:")).toBe(false);
  });
});
