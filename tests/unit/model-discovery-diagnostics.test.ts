import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-discovery-diagnostics-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerModelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const syncModelsRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");

const originalFetch = globalThis.fetch;

type ModelRow = { id: string };
type ModelsBody = {
  provider?: string;
  source?: string;
  intentional?: boolean;
  models?: ModelRow[];
  discoveryFailure?: Record<string, unknown>;
  degraded?: boolean;
  error?: string;
  failure?: unknown;
};

async function resetStorage() {
  globalThis.fetch = originalFetch;
  syncModelsRoute.__resetLoopbackReadinessForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function callRoute(connectionId: string, search = "") {
  return providerModelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
    { params: { id: connectionId } }
  );
}

test.beforeEach(resetStorage);

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a failed no-auth live catalog stays degraded instead of becoming intentional", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "aihorde",
    authType: "no-auth",
    name: "aihorde-diagnostics-test",
    isActive: true,
    testStatus: "active",
  });
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

  const response = await callRoute(connection.id);
  const body = (await response.json()) as ModelsBody;

  assert.equal(response.status, 200);
  assert.equal(body.source, "local_catalog");
  assert.notEqual(body.intentional, true);
});

test("Copilot route returns safe structured failure diagnostics with its fallback warning", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: "github-diagnostics-test",
    accessToken: "github-access-secret",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { copilotToken: "copilot-token-secret" },
  });
  globalThis.fetch = async () =>
    new Response('{"private":"must-not-leak"}', {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const response = await callRoute(connection.id, "?refresh=true");
  const body = (await response.json()) as ModelsBody;

  assert.equal(response.status, 200);
  assert.equal(body.source, "local_catalog");
  assert.deepEqual(body.discoveryFailure, {
    kind: "http_status",
    upstreamStatus: 503,
    contentType: "application/json",
    bodyShape: "json",
  });
  // One shape: the structured diagnostics stay published as `discoveryFailure`
  // and the closed-vocabulary cause is derived from them, never rebuilt apart.
  assert.equal(body.degraded, true);
  assert.equal(body.error, "HTTP 503");
  assert.equal("failure" in body, false, "the internal failure never reaches the response");
  assert.doesNotMatch(
    JSON.stringify(body),
    /must-not-leak|github-access-secret|copilot-token-secret/
  );
});
