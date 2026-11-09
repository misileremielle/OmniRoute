// #18745: /api/usage/quota must not report an unknown quota as 100% remaining.
// A connection with no learned rate-limit headers, no active cooldown and no queue
// pressure has no quota signal at all, so `percentRemaining` is `null`, not 100.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-unknown-18745-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { sanitizeQuotaProvider, normalizeQuotaResponse } =
  await import("../../src/shared/contracts/quota.ts");
const { GET } = await import("../../src/app/api/usage/quota/route.ts");
const { checkQuotaOutput } = await import("../../open-sse/mcp-server/schemas/tools.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#18745 sanitizeQuotaProvider reports an unknown quota as null, not 100", () => {
  const entry = sanitizeQuotaProvider({ provider: "github", connectionId: "c1", quotaTotal: null });
  assert.equal(entry.quotaTotal, null);
  assert.equal(entry.percentRemaining, null);

  assert.equal(sanitizeQuotaProvider({ provider: "github", quotaTotal: 0 }).percentRemaining, null);
});

test("#18745 sanitizeQuotaProvider still derives or clamps a known percentage", () => {
  const derived = sanitizeQuotaProvider({ provider: "openai", quotaTotal: 100, quotaUsed: 20 });
  assert.equal(derived.percentRemaining, 80);

  const explicit = sanitizeQuotaProvider({ provider: "openai", percentRemaining: 140 });
  assert.equal(explicit.quotaTotal, null);
  assert.equal(explicit.percentRemaining, 100);

  const explicitZero = sanitizeQuotaProvider({ provider: "openai", percentRemaining: 0 });
  assert.equal(explicitZero.percentRemaining, 0);
});

test("#18745 GET /api/usage/quota reports a connection with no quota signal as unknown", async () => {
  const conn = (await providersDb.createProviderConnection({
    provider: "mistral",
    authType: "apikey",
    name: "quota unknown 18745",
  })) as { id: string };

  const res = await GET(new Request(`http://localhost/api/usage/quota?connectionId=${conn.id}`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { providers: Array<Record<string, unknown>> };

  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].connectionId, conn.id);
  assert.equal(body.providers[0].quotaTotal, null);
  assert.equal(body.providers[0].percentRemaining, null);
});

test("#18745 the MCP check_quota output schema accepts an unknown percentage", () => {
  const response = normalizeQuotaResponse({
    providers: [{ provider: "github", name: "main", connectionId: "c1", quotaTotal: null }],
  });
  assert.equal(response.providers[0].percentRemaining, null);
  assert.equal(checkQuotaOutput.safeParse(response).success, true);
});
