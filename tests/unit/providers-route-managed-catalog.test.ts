import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";
import { settleConnectionFollowUpsAfterEachTest } from "../helpers/connectionFollowUps.ts";

settleConnectionFollowUpsAfterEachTest();

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-providers-managed-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-for-managed-providers";
process.env.INITIAL_PASSWORD = "admin-secret";

// Each connection this file creates is auto-tested in the background. None of those probes may
// reach the network, or a service that happens to listen on a fixture's localhost port.
const previousDispatcher = getGlobalDispatcher();
const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);

const core = await import("../../src/lib/db/core.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

// After the imports: loading the route loads proxyFetch, which replaces globalThis.fetch with its
// own fetch on explicit dispatchers (the MockAgent above never sees those). Without this stub the
// auto-tests reach the real providers, and the settle hook above depends on their response time.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ data: [], models: [] });

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(async () => {
  globalThis.fetch = previousFetch;
  setGlobalDispatcher(previousDispatcher);
  await network.close();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("providers route rejects upstream proxy tools as direct provider connections", async () => {
  const response = await providersRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "POST",
      body: {
        provider: "cliproxyapi",
        apiKey: "cpa-key",
        name: "CLIProxyAPI",
      },
    })
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid provider" });
});

test("DELETE /api/providers batch deletes connections", async () => {
  const createReq = async (provider, name, apiKey) =>
    providersRoute.POST(
      await makeManagementSessionRequest("http://localhost/api/providers", {
        method: "POST",
        body: { provider, name, apiKey },
      })
    );

  const r1 = await createReq("together", "Conn 1", "key-1");
  const r2 = await createReq("together", "Conn 2", "key-2");
  const r3 = await createReq("together", "Conn 3", "key-3");
  const id1 = (await r1.json()).connection.id;
  const id2 = (await r2.json()).connection.id;
  const id3 = (await r3.json()).connection.id;
  await modelsDb.addCustomModel("together", "manual-model", "Manual", "manual");
  await modelsDb.addCustomModel("together", "imported-model", "Imported", "imported");

  const deleteRes = await providersRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "DELETE",
      body: { ids: [id1, id3] },
    })
  );

  assert.equal(deleteRes.status, 200);
  const deletePayload = (await deleteRes.json()) as any;
  assert.equal(deletePayload.deleted, 2);

  const listRes = await providersRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers")
  );
  const listPayload = (await listRes.json()) as any;
  const remainingIds = listPayload.connections.map((c) => c.id);
  assert.equal(remainingIds.includes(id1), false);
  assert.equal(remainingIds.includes(id3), false);
  assert.equal(remainingIds.includes(id2), true);
  assert.deepEqual(
    (await modelsDb.getCustomModels("together")).map((model: { id: string }) => model.id),
    ["manual-model", "imported-model"]
  );

  const deleteLastRes = await providersRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "DELETE",
      body: { ids: [id2] },
    })
  );
  assert.equal(deleteLastRes.status, 200);
  assert.deepEqual(
    (await modelsDb.getCustomModels("together")).map((model: { id: string }) => model.id),
    ["manual-model"]
  );
});

test("DELETE /api/providers rejects empty ids array", async () => {
  const res = await providersRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "DELETE",
      body: { ids: [] },
    })
  );
  assert.equal(res.status, 400);
});

test("DELETE /api/providers rejects ids over 100 limit", async () => {
  const res = await providersRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "DELETE",
      body: { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) },
    })
  );
  assert.equal(res.status, 400);
  const payload = (await res.json()) as any;
  assert.equal(payload.error, "Cannot delete more than 100 connections at once");
});

test("DELETE /api/providers rejects non-array ids", async () => {
  const res = await providersRoute.DELETE(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "DELETE",
      body: { ids: "not-an-array" },
    })
  );
  assert.equal(res.status, 400);
});
