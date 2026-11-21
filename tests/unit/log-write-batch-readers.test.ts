// Step-11 fix 3: every reader that must see all usage (limits, quotas, team budgets, rollups,
// resets, identity repair) writes the queued log rows before it reads. Batching is on here.
//
// Method: wrap the handle's prepare() and record the queue length at the first statement that
// touches usage_history or call_logs. A reader that flushes first records 0 (the flush's own
// INSERT comes first, with the queue already taken); one that does not records the queued rows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-log-batch-readers-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_LOG_BATCH_MS = "5000";
process.env.API_KEY_SECRET = "log-batch-readers-fixture";

const core = await import("../../src/lib/db/core.ts");
const batch = await import("../../src/lib/usage/logWriteBatch.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const artifactWriter = await import("../../src/lib/usage/callLogArtifactWriter.ts");
const apiKeySpend = await import("../../src/lib/db/apiKeySpend.ts");
const tokenLimitCounter = await import("../../open-sse/services/tokenLimitCounter.ts");
const tokenLimits = await import("../../src/lib/db/tokenLimits.ts");
const selfService = await import("../../src/lib/usage/apiKeySelfService.ts");
const teamLimits = await import("../../src/lib/usage/teamUsageLimits.ts");
const teams = await import("../../src/lib/db/teams.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const usageStats = await import("../../src/lib/usage/usageStats.ts");
const antigravity = await import("../../open-sse/services/usage/antigravity.ts");
const aggregate = await import("../../src/lib/usage/aggregateHistory.ts");
const cleanup = await import("../../src/lib/db/cleanup.ts");
const providers = await import("../../src/lib/db/providers.ts");

test.after(async () => {
  await batch.waitForLogWriteBatch();
  await artifactWriter.closeCallLogArtifactWriter();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(async () => {
  await batch.waitForLogWriteBatch();
  batch.resetLogWriteBatchForTests();
});

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

async function queueUsage(extra: Record<string, unknown> = {}) {
  await usageHistory.saveRequestUsage({
    provider: "openai",
    model: "gpt-reader",
    tokens: { input: 10, output: 5 },
    status: "200",
    success: true,
    latencyMs: 5,
    timestamp: iso(NOW - 60_000),
    ...extra,
  });
  assert.ok(batch.getQueuedLogWriteCount() >= 1, "the row is queued, not written");
}

/** Queue length at the first statement touching the log tables while `run` executes. */
async function queueAtFirstLogStatement(run: () => unknown): Promise<number | null> {
  const db = core.getDbInstance();
  const original = db.prepare;
  let seen: number | null = null;
  db.prepare = ((sql: string) => {
    if (seen === null && /\b(usage_history|call_logs)\b/.test(sql)) {
      seen = batch.getQueuedLogWriteCount();
    }
    return original.call(db, sql);
  }) as typeof db.prepare;
  try {
    await run();
  } finally {
    db.prepare = original;
  }
  return seen;
}

async function assertFlushesFirst(name: string, run: () => unknown) {
  const seen = await queueAtFirstLogStatement(run);
  assert.equal(seen, 0, `${name}: queued rows were still queued at its first log-table read`);
  assert.equal(batch.getQueuedLogWriteCount(), 0, `${name}: nothing left queued`);
}

test("the hook itself sees queued rows when nothing flushes", async () => {
  await queueUsage();
  const seen = await queueAtFirstLogStatement(() =>
    core.getDbInstance().prepare("SELECT COUNT(*) AS n FROM usage_history").get()
  );
  assert.equal(seen, 1);
});

test("getApiKeySpendRows sees a queued row", async () => {
  await queueUsage({ apiKeyId: "key-spend" });
  await assertFlushesFirst("getApiKeySpendRows", () =>
    apiKeySpend.getApiKeySpendRows("key-spend", iso(NOW - 3_600_000))
  );
  assert.equal(apiKeySpend.getApiKeySpendRows("key-spend", iso(NOW - 3_600_000)).length, 1);
});

test("seedWindowUsageFromHistory counts a queued row", async () => {
  const limit = tokenLimits.upsertTokenLimit({
    apiKeyId: "key-seed",
    scopeType: "global",
    tokenLimit: 1_000_000,
    resetInterval: "daily",
  });
  await queueUsage({ apiKeyId: "key-seed" });
  let seeded = -1;
  await assertFlushesFirst("seedWindowUsageFromHistory", () => {
    seeded = tokenLimitCounter.seedWindowUsageFromHistory(limit, NOW);
  });
  assert.equal(seeded, 15);
});

test("recordTokenUsage for a limited key flushes before its transaction", async () => {
  tokenLimits.upsertTokenLimit({
    apiKeyId: "key-limited",
    scopeType: "global",
    tokenLimit: 1_000_000,
    resetInterval: "daily",
  });
  await queueUsage({ apiKeyId: "key-limited" });
  const db = core.getDbInstance();
  const originalTransaction = db.transaction;
  let queuedAtTransaction: number | null = null;
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    queuedAtTransaction ??= batch.getQueuedLogWriteCount();
    return originalTransaction.call(db, fn);
  }) as typeof db.transaction;
  try {
    tokenLimitCounter.recordTokenUsage("key-limited", "openai", "gpt-reader", 7, NOW);
    // It runs on a microtask; give it a few turns.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    db.transaction = originalTransaction;
  }
  assert.equal(queuedAtTransaction, 0, "queue empty when its transaction opened");
});

test("the self-service status reads after a flush", async () => {
  await queueUsage({ apiKeyId: "key-self" });
  await assertFlushesFirst("buildApiKeySelfServiceStatus", () =>
    selfService.buildApiKeySelfServiceStatus(
      { id: "key-self", name: "self", scopes: [], allowedConnections: [] },
      {},
      { adminPreview: true }
    )
  );
});

test("the team budget counts a queued row", async () => {
  const team = teams.createTeam({ name: "Readers", maxBudgetUsd: 1000, budgetDuration: "7d" });
  const key = await keys.createApiKey("readers", "log-batch-readers");
  teams.assignApiKeyBillingTeam(key.id, team.id, iso(NOW - 86_400_000));
  core
    .getDbInstance()
    .prepare("UPDATE teams SET budget_reset_at = ? WHERE id = ?")
    .run(iso(NOW + 86_400_000), team.id);
  await queueUsage({ apiKeyId: key.id });
  await assertFlushesFirst("getTeamUsageLimitStatusForTeam", () =>
    teamLimits.getTeamUsageLimitStatusForTeam(team.id, NOW)
  );
  await queueUsage({ apiKeyId: key.id });
  await assertFlushesFirst("getTeamUsageLimitStatusForApiKey", () =>
    teamLimits.getTeamUsageLimitStatusForApiKey(key.id, NOW)
  );
});

test("both usageStats quota readers flush first", async () => {
  await queueUsage({ connectionId: "conn-stats" });
  await assertFlushesFirst("getMonthlyProviderTokensForConnection", () =>
    usageStats.getMonthlyProviderTokensForConnection("openai", "conn-stats")
  );
  await queueUsage({ connectionId: "conn-stats" });
  await assertFlushesFirst("getConnectionSpendUsdSinceAdded", () =>
    usageStats.getConnectionSpendUsdSinceAdded("openai", "conn-stats")
  );
});

test("the antigravity local-usage fallback counts a queued row", async () => {
  await queueUsage({ provider: "antigravity", connectionId: "conn-agy", model: "agy-model" });
  let units = -1;
  await assertFlushesFirst("getAntigravityLocalUsageUnits", () => {
    units = antigravity.getAntigravityLocalUsageUnits(
      "antigravity",
      "conn-agy",
      "agy-model",
      iso(NOW + 3_600_000)
    );
  });
  assert.ok(units > 0, "the queued row's tokens are counted");
});

test("the usage rollup flushes first", async () => {
  await queueUsage();
  await assertFlushesFirst("rollupUsageHistoryBeforeDate", () =>
    aggregate.rollupUsageHistoryBeforeDate(iso(NOW + 86_400_000).slice(0, 10))
  );
});

test("resetting usage history flushes first, so no queued row reappears", async () => {
  await queueUsage();
  await assertFlushesFirst("resetUsageHistory", () => cleanup.resetUsageHistory("all"));
  assert.equal(
    Number(
      (
        core.getDbInstance().prepare("SELECT COUNT(*) AS n FROM usage_history").get() as {
          n: number;
        }
      ).n
    ),
    0
  );
});

test("updating an identity field of a connection flushes first; other fields do not", async () => {
  const conn = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "reader conn",
    apiKey: "sk-reader-test-0000000000000000",
  });
  const id = String((conn as { id: string }).id);

  await queueUsage({ connectionId: id });
  await providers.updateProviderConnection(id, { name: "renamed" });
  assert.equal(batch.getQueuedLogWriteCount(), 1, "a rename does not touch usage identity");

  await providers.updateProviderConnection(id, { email: "owner@example.com" });
  assert.equal(batch.getQueuedLogWriteCount(), 0, "an identity field flushes first");
});

test("promoting a Codex identity on create flushes first", async () => {
  await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex ws",
    email: "dev@example.com",
    accessToken: "at-1",
    refreshToken: "rt-1",
    providerSpecificData: { workspaceId: "ws-readers" },
  });
  await queueUsage({ provider: "codex" });
  await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex ws",
    email: "dev@example.com",
    accessToken: "at-2",
    refreshToken: "rt-2",
    providerSpecificData: { workspaceId: "ws-readers", chatgptUserId: "user-readers" },
  });
  assert.equal(batch.getQueuedLogWriteCount(), 0);
});
