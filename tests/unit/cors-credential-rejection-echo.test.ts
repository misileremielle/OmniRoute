/**
 * #5242 follow-up to the CLIENT_API validated-key CORS rule.
 *
 * With REQUIRE_API_KEY=false the authz pipeline serves an unvalidated key as
 * anonymous and does not echo the Origin. A route that then refuses the key
 * with its own 401 must restore the echo so browser/Electron clients can read
 * the rejection, while a response served to the anonymous caller still gets no
 * Access-Control-Allow-Origin.
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir before any db module loads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cors-rejection-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-secret-cors-rejection";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsModule = await import("../../src/lib/db/settings.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const sessionLeasesRoute = await import("../../src/app/api/v1/session-leases/route.ts");

const ORIGIN = "https://app.example";
const originalRequireApiKey = process.env.REQUIRE_API_KEY;

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

test.beforeEach(async () => {
  delete process.env.CORS_ALLOW_ALL;
  delete process.env.CORS_ALLOWED_ORIGINS;
  process.env.REQUIRE_API_KEY = "false";
  await resetStorage();
});

test.after(() => {
  if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = originalRequireApiKey;
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function crossOrigin(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers: { origin: ORIGIN, ...headers } });
}

test("/v1/models 401 for a refused key echoes the Origin when management auth is configured", async () => {
  await settingsModule.updateSettings({ password: "test-password-cors", requireLogin: true });

  const res = await v1ModelsCatalog.getUnifiedModelsResponse(
    crossOrigin("http://test.example.com/v1/models", { authorization: "Bearer junk" })
  );

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "invalid_api_key");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Vary") || "", /Origin/);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
});

test("/v1/models 401 without a presented key does not echo the Origin", async () => {
  await settingsModule.updateSettings({ password: "test-password-cors", requireLogin: true });

  const res = await v1ModelsCatalog.getUnifiedModelsResponse(
    crossOrigin("http://test.example.com/v1/models")
  );

  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("/v1/models served to an anonymous caller with a junk key does not echo the Origin", async () => {
  await settingsModule.updateSettings({ requireAuthForModels: false });

  const res = await v1ModelsCatalog.getUnifiedModelsResponse(
    crossOrigin("http://test.example.com/v1/models", { authorization: "Bearer junk" })
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("/v1/session-leases 401 for a refused key echoes the Origin", async () => {
  const res = await sessionLeasesRoute.POST(
    new Request("http://localhost/api/v1/session-leases", {
      method: "POST",
      headers: { origin: ORIGIN, authorization: "Bearer junk", "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    })
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(res.headers.get("Content-Type"), "application/json");
});
