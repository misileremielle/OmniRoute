import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Model sync discovers through the chat surface, so a speech / transcription /
// image model never comes back from it. Sync used to drop every imported row
// before re-adding what it discovered, which silently deleted every model a
// media-only provider (Soniox, ElevenLabs, …) had imported from its local catalog
// on the next sync cycle — every 6 h and on every restart. API keys with
// "Disable Non-Public Models" then answered 403 for those models again.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-sync-media-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= `test-model-sync-media-${Date.now()}`;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { importManagedModels } = await import("../../src/lib/providerModels/managedModelImport.ts");

const originalFetch = globalThis.fetch;

type StoredModel = { id: string; source?: string; apiFormat?: string };

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("sync still replaces imported chat rows with the discovered catalog", async () => {
  await modelsDb.addCustomModel("openai", "gpt-old-chat", "Old chat", "imported");
  await modelsDb.addCustomModel(
    "openai",
    "whisper-imported",
    "Whisper",
    "imported",
    "audio-transcriptions",
    ["audio-transcriptions"]
  );

  await importManagedModels({
    providerId: "openai",
    connectionId: "openai-media-sync-conn",
    mode: "sync",
    fetchedModels: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
  });

  const stored = (await modelsDb.getCustomModels("openai")) as StoredModel[];
  assert.deepEqual(
    stored.map((model) => model.id),
    ["whisper-imported"]
  );
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModelsForConnection("openai", "openai-media-sync-conn")).map(
      (model) => model.id
    ),
    ["gpt-5.6-sol"]
  );
});

test("sync still replaces an imported row stored with the synthetic chat default", async () => {
  // OpenAI image rows imported before endpoint metadata existed carry ["chat"];
  // they keep the old replace-on-sync behaviour instead of becoming permanent.
  await modelsDb.addCustomModel("openai", "gpt-image-1", "GPT Image 1", "imported");

  await importManagedModels({
    providerId: "openai",
    connectionId: "openai-synthetic-chat-conn",
    mode: "sync",
    fetchedModels: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
  });

  const stored = (await modelsDb.getCustomModels("openai")) as StoredModel[];
  assert.equal(
    stored.some((model) => model.id === "gpt-image-1"),
    false
  );
});

test("self-hosted providers keep replacing every imported row, since their discovery is unfiltered", async () => {
  await modelsDb.addCustomModel(
    "ollama-local",
    "nomic-embed-text",
    "Nomic Embed",
    "imported",
    "embeddings",
    ["embeddings"]
  );

  await importManagedModels({
    providerId: "ollama-local",
    connectionId: "ollama-local-conn",
    mode: "sync",
    fetchedModels: [{ id: "llama3.3", name: "Llama 3.3" }],
  });

  const stored = (await modelsDb.getCustomModels("ollama-local")) as StoredModel[];
  assert.deepEqual(stored, []);
});
