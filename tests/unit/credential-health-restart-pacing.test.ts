/**
 * A restart must not re-probe every connection. The sweep's pacing lived only in memory, so
 * 30s after every boot it treated all connections as never tested and sent one live upstream
 * probe per account (each writing a call log, a proxy log and the connection row). The sweep
 * now seeds its pacing from the persisted `lastTested`: a recently tested healthy connection
 * waits for its interval, a failing one for the first backoff step, and a connection that was
 * never tested (or is overdue) is still probed right away.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "credential-health-restart-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "credential-health-restart-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  return new Response(JSON.stringify({ data: [{ id: "gpt-test", object: "model" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection, getProviderConnections } =
  await import("../../src/lib/db/providers.ts");
const scheduler = await import("../../src/lib/credentialHealth/scheduler.ts");

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function seed(name: string, lastTested: string | null, testStatus: string) {
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus,
    ...(lastTested ? { lastTested } : {}),
  });
}

test("a fresh sweep after restart probes only connections that are actually due", async () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  await seed("recent-healthy", minutesAgo(2), "active");
  await seed("recent-failing", minutesAgo(2), "error");
  await seed("overdue-healthy", minutesAgo(24 * 60), "active");
  await seed("stale-failing", minutesAgo(30), "error");
  await seed("never-tested", null, "unknown");

  const sweepStartedAt = Date.now();
  scheduler.__test_resetCredentialHealthScheduler();
  await scheduler.sweep();

  const rows = (await getProviderConnections({ provider: "openai" })) as Array<{
    name: string;
    lastTested?: string | null;
  }>;
  const probed = rows
    .filter((row) => row.lastTested && Date.parse(row.lastTested) >= sweepStartedAt)
    .map((row) => row.name)
    .sort();
  assert.deepEqual(
    probed,
    ["never-tested", "overdue-healthy", "stale-failing"],
    "recently tested connections must keep their pacing across a restart"
  );
});
