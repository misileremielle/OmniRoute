/**
 * /v1/models lists the speech-to-text models of the transcription registry for every provider
 * with an active connection. Clients such as Nomily AI's Custom ASR fill their model picker
 * from this list, then send the id to POST /v1/audio/transcriptions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stt-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Asserts catalog contents, not the cold-build time bound.
process.env.CATALOG_BUILD_TIMEOUT_MS ??= "180000";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function connectProvider(provider: string, providerSpecificData?: Record<string, unknown>) {
  return (await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-conn`,
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
    ...(providerSpecificData ? { providerSpecificData } : {}),
  })) as { id: string };
}

async function catalog(): Promise<Array<Record<string, unknown>>> {
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Array<Record<string, unknown>> }).data;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("an Azure Speech connection publishes both MAI-Transcribe models as transcription models", async () => {
  await connectProvider("azure-speech", { baseUrl: "https://eastus.api.cognitive.microsoft.com" });
  const data = await catalog();
  for (const id of ["azure-speech/mai-transcribe-2", "azure-speech/mai-transcribe-1.5"]) {
    const entry = data.find((model) => model.id === id);
    assert.ok(entry, `expected ${id} in /v1/models`);
    assert.equal(entry!.type, "audio");
    assert.equal(entry!.subtype, "transcription");
    assert.equal(entry!.owned_by, "azure-speech");
  }
});

test("without a connection no transcription model is published", async () => {
  const data = await catalog();
  assert.deepEqual(
    data.filter((model) => String(model.id).startsWith("azure-speech/")).map((m) => m.id),
    []
  );
});

test("a model discovery already lists is not published twice", async () => {
  const connection = await connectProvider("openrouter");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connection.id, [
    {
      id: "microsoft/mai-transcribe-2",
      name: "MAI-Transcribe 2",
      source: "imported",
      supportedEndpoints: ["audio-transcriptions"],
    },
  ]);
  const matches = (await catalog()).filter(
    (model) => model.id === "openrouter/microsoft/mai-transcribe-2"
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, "audio");
  assert.equal(matches[0].subtype, "transcription");
});
