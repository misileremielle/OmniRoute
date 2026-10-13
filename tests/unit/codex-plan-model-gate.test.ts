/**
 * Codex Astra- and Sol-tier models (gpt-*-astra, gpt-*-sol, with or without a
 * suffix such as -high) only run on Pro and Prolite ChatGPT plans. Connections
 * on any other plan, or with no plan recorded, are skipped for those models
 * and stay eligible for every other model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-plan-gate-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { isModelBlockedByCodexPlan } = await import("../../src/domain/connectionModelRules.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("gates Astra and Sol models of any version and suffix", () => {
  const plus = { chatgptPlanType: "plus" };
  for (const model of [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-astra-high",
    "gpt-7-sol-mini",
    "codex/gpt-6-astra",
    "cx/GPT-6-SOL",
  ]) {
    assert.equal(isModelBlockedByCodexPlan("codex", model, plus), true, model);
  }
  for (const model of ["gpt-6", "gpt-6-codex", "gpt-6-solar", "gpt-6-astral", "astra"]) {
    assert.equal(isModelBlockedByCodexPlan("codex", model, plus), false, model);
  }
});

test("allows Pro and Prolite plans, reading workspacePlanType before chatgptPlanType", () => {
  assert.equal(isModelBlockedByCodexPlan("codex", "gpt-6-sol", { chatgptPlanType: "pro" }), false);
  assert.equal(
    isModelBlockedByCodexPlan("codex", "gpt-6-sol", { workspacePlanType: " ProLite " }),
    false
  );
  assert.equal(
    isModelBlockedByCodexPlan("codex", "gpt-6-sol", {
      workspacePlanType: "team",
      chatgptPlanType: "pro",
    }),
    true
  );
  assert.equal(isModelBlockedByCodexPlan("codex", "gpt-6-sol", {}), true);
  assert.equal(isModelBlockedByCodexPlan("codex", "gpt-6-sol", null), true);
});

test("only applies to the Codex provider", () => {
  assert.equal(
    isModelBlockedByCodexPlan("openai", "gpt-6-sol", { chatgptPlanType: "plus" }),
    false
  );
});

async function createCodexConnection(name: string, priority: number, plan?: string) {
  const created = (await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name,
    priority,
    isActive: true,
    testStatus: "active",
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    ...(plan ? { providerSpecificData: { chatgptPlanType: plan } } : {}),
  })) as { id: string };
  return created.id;
}

test("selection skips non-Pro accounts for Sol and keeps them for other models", async () => {
  const plusId = await createCodexConnection("plus-account", 1, "plus");
  const proId = await createCodexConnection("pro-account", 2, "pro");

  const sol = (await auth.getProviderCredentials("codex", null, null, "gpt-6-sol")) as {
    connectionId?: string;
  };
  assert.equal(sol?.connectionId, proId);

  const other = (await auth.getProviderCredentials("codex", null, null, "gpt-6")) as {
    connectionId?: string;
  };
  assert.equal(other?.connectionId, plusId);

  const viaAlias = (await auth.getProviderCredentials("cx", null, null, "gpt-6-astra-high")) as {
    connectionId?: string;
  };
  assert.equal(viaAlias?.connectionId, proId);
});
