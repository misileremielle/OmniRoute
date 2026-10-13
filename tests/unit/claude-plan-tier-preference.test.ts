/**
 * Claude Max 20x accounts serve requests before Max 5x accounts, and both before
 * Pro (or any other plan). A lower tier is only used when no higher-tier account
 * is available, whatever the selection strategy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-plan-tier-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { getClaudePlanRank, preferHighestClaudePlan } =
  await import("../../src/domain/claudePlanTier.ts");

const MAX_20X = {
  organizationType: "claude_max",
  organizationRateLimitTier: "default_claude_max_20x",
};
const MAX_5X = {
  organizationType: "claude_max",
  organizationRateLimitTier: "default_claude_max_5x",
};
const PRO = { organizationType: "claude_pro", organizationRateLimitTier: "default_claude_ai" };

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("ranks Max 20x above Max 5x above every other plan", () => {
  assert.equal(getClaudePlanRank(MAX_20X), 2);
  assert.equal(getClaudePlanRank(MAX_5X), 1);
  assert.equal(getClaudePlanRank({ organizationType: "claude_max" }), 1);
  assert.equal(getClaudePlanRank(PRO), 0);
  assert.equal(getClaudePlanRank({ organizationType: "claude_team" }), 0);
  assert.equal(getClaudePlanRank({}), 0);
  assert.equal(getClaudePlanRank(null), 0);
});

test("keeps only the highest tier present, plus a leased connection", () => {
  const pool = [
    { id: "pro", providerSpecificData: PRO },
    { id: "max5", providerSpecificData: MAX_5X },
    { id: "max20", providerSpecificData: MAX_20X },
  ];
  assert.deepEqual(
    preferHighestClaudePlan("claude", pool).map((c) => c.id),
    ["max20"]
  );
  assert.deepEqual(
    preferHighestClaudePlan("claude", pool.slice(0, 2)).map((c) => c.id),
    ["max5"]
  );
  assert.deepEqual(
    preferHighestClaudePlan("claude", pool, "pro").map((c) => c.id),
    ["pro", "max20"]
  );
  assert.equal(preferHighestClaudePlan("openai", pool), pool);
  const allPro = [
    { id: "a", providerSpecificData: PRO },
    { id: "b", providerSpecificData: {} },
  ];
  assert.equal(preferHighestClaudePlan("claude", allPro), allPro);
});

async function createClaudeConnection(name: string, priority: number, plan: object) {
  const created = (await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name,
    priority,
    isActive: true,
    testStatus: "active",
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    providerSpecificData: plan,
  })) as { id: string };
  return created.id;
}

async function selectedId(): Promise<string | undefined> {
  const selected = (await auth.getProviderCredentials(
    "claude",
    null,
    null,
    "claude-sonnet-5-5"
  )) as {
    connectionId?: string;
  } | null;
  return selected?.connectionId;
}

test("fill-first selection prefers Max over a higher-priority Pro account", async () => {
  await resetStorage();
  await createClaudeConnection("pro", 1, PRO);
  const max5Id = await createClaudeConnection("max5", 2, MAX_5X);
  const max20Id = await createClaudeConnection("max20", 3, MAX_20X);

  assert.equal(await selectedId(), max20Id);

  await providersDb.updateProviderConnection(max20Id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await selectedId(), max5Id);
});

test("Pro is used once every Max account is unavailable", async () => {
  await resetStorage();
  const proId = await createClaudeConnection("pro", 2, PRO);
  const max20Id = await createClaudeConnection("max20", 1, MAX_20X);
  await providersDb.updateProviderConnection(max20Id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await selectedId(), proId);
});

test("round-robin rotates among Max accounts only while one is available", async () => {
  await resetStorage();
  await settingsDb.updateSettings({ fallbackStrategy: "round-robin" });
  await createClaudeConnection("pro", 1, PRO);
  const a = await createClaudeConnection("max-a", 2, MAX_20X);
  const b = await createClaudeConnection("max-b", 3, MAX_20X);

  const seen = new Set<string | undefined>();
  for (let i = 0; i < 6; i += 1) seen.add(await selectedId());
  assert.deepEqual([...seen].sort(), [a, b].sort());
});
