/**
 * The per-key dollar budget gates every endpoint at the policy phase, but only
 * chat and web search ever charged it. Image, speech, video/music and rerank
 * routes already price each successful call (`calculateModalCost`) — the
 * number was only attached to the X-OmniRoute cost header — so a key with a
 * budget could spend without limit on those routes. They now charge the
 * metered share of that cost to the budget, like chat does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-modal-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budget-modal-routes-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { saveSyncedPricing } = await import("../../src/lib/pricingSync.ts");
const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const costRules = await import("../../src/domain/costRules.ts");
const rerankRoute = await import("../../src/app/api/v1/rerank/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  await waitForCallLogSaves(10_000);
  globalThis.fetch = originalFetch;
  costRules.resetCostData();
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await waitForCallLogSaves(10_000);
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedConnection(provider: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-budget-modal`,
    apiKey: `${provider}-upstream-key`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function keyWithDailyBudget(limitUsd: number) {
  const created = await apiKeysDb.createApiKey("Budgeted media key", "machine-budget-modal");
  apiKeysDb.clearApiKeyCaches();
  costRules.setBudget(created.id, { dailyLimitUsd: limitUsd, resetInterval: "daily" });
  return created;
}

function post(url: string, key: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

function spent(apiKeyId: string): number {
  return Number(costRules.checkBudget(apiKeyId).periodUsed) || 0;
}

test("rerank: a priced call charges the key's dollar budget", async () => {
  saveSyncedPricing({ cohere: { "rerank-v3.5": { input: 0, output: 0, search_unit_cost: 0.5 } } });
  await seedConnection("cohere");
  const key = await keyWithDailyBudget(10);
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(String(url), "https://api.cohere.com/v2/rerank");
    return new Response(
      JSON.stringify({
        id: "rerank-budget",
        results: [{ index: 0, relevance_score: 0.9 }],
        meta: { billed_units: { search_units: 3 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const response = await rerankRoute.POST(
    post("http://localhost/api/v1/rerank", key.key, {
      model: "cohere/rerank-v3.5",
      query: "budget",
      documents: ["a", "b"],
    })
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(Math.abs(spent(key.id) - 1.5) < 1e-9, `expected $1.5 charged, got ${spent(key.id)}`);
});

test("recordModalCallCost: flat-rate providers, zero costs and keyless calls charge nothing", async () => {
  const key = await keyWithDailyBudget(10);
  costRules.recordModalCallCost(key.id, { provider: "opencode-go", model: "m", costUsd: 3 });
  costRules.recordModalCallCost(key.id, { provider: "openai", model: "m", costUsd: 0 });
  costRules.recordModalCallCost(null, { provider: "openai", model: "m", costUsd: 3 });
  assert.equal(spent(key.id), 0);
  costRules.recordModalCallCost(key.id, { provider: "openai", model: "m", costUsd: 0.75 });
  assert.ok(Math.abs(spent(key.id) - 0.75) < 1e-9);
});
