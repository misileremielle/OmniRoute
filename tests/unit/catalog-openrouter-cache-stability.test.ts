import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelCapabilityEntry } from "../../src/lib/modelsDevSync.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-openrouter-stability-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  API_KEY_SECRET: "catalog-stability-fixture-secret",
  DISABLE_SQLITE_AUTO_BACKUP: "true",
  APP_LOG_TO_FILE: "false",
});

const core = await import("../../src/lib/db/core.ts");
const _providers = await import("../../src/lib/db/providers.ts");
const _settings = await import("../../src/lib/db/settings.ts");
const _catalog = await import("../../src/app/api/v1/models/catalog.ts");
const { upsertSyncedCapabilities, getSyncedCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");
const { getModelCatalogCacheVersion } = await import("../../src/lib/db/readCache.ts");
const { openRouterCapabilityEntry } =
  await import("../../src/app/api/v1/models/catalogOpenrouter.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("capability upserts invalidate only for real changes, including nullable fields", () => {
  const empty: ModelCapabilityEntry = {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: "[]",
    modalities_output: "[]",
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    reasoning_efforts: null,
  };
  const populated: ModelCapabilityEntry = {
    tool_call: false,
    reasoning: true,
    attachment: false,
    structured_output: true,
    temperature: false,
    modalities_input: '["text","image"]',
    modalities_output: '["text"]',
    knowledge_cutoff: "2025-01",
    release_date: "2025-01-01",
    last_updated: "2026-01-01",
    status: "active",
    family: "fixture",
    open_weights: false,
    limit_context: 8192,
    limit_input: 4096,
    limit_output: 1024,
    interleaved_field: "reasoning_content",
    reasoning_efforts: ["low", "high"],
  };
  upsertSyncedCapabilities("other-fixture-provider", { retained: empty });
  const beforeInsert = getModelCatalogCacheVersion();
  upsertSyncedCapabilities("fixture-provider", { "nullable-model": empty });
  assert.notEqual(getModelCatalogCacheVersion(), beforeInsert, "new rows invalidate");

  for (const [field, value] of Object.entries(populated)) {
    const changed = { ...empty, [field]: value };
    const before = getModelCatalogCacheVersion();
    upsertSyncedCapabilities("fixture-provider", { "nullable-model": changed });
    const after = getModelCatalogCacheVersion();
    assert.notEqual(after, before, `${field}: changed value must invalidate`);
    assert.deepEqual(
      getSyncedCapabilities("fixture-provider")["fixture-provider"]["nullable-model"],
      changed
    );

    upsertSyncedCapabilities("fixture-provider", { "nullable-model": { ...changed } });
    assert.equal(
      getModelCatalogCacheVersion(),
      after,
      `${field}: identical value must not invalidate`
    );

    upsertSyncedCapabilities("fixture-provider", { "nullable-model": empty });
    const cleared = getModelCatalogCacheVersion();
    assert.notEqual(cleared, after, `${field}: cleared value must invalidate`);
    upsertSyncedCapabilities("fixture-provider", { "nullable-model": { ...empty } });
    assert.equal(
      getModelCatalogCacheVersion(),
      cleared,
      `${field}: identical empty value must not invalidate`
    );
  }
  assert.deepEqual(
    getSyncedCapabilities("other-fixture-provider")["other-fixture-provider"].retained,
    empty
  );
});

test("OpenRouter modality permutations and duplicates preserve catalog generation", () => {
  const modelId = "fixture/modality-sets";
  function discover(input: string[], output: string[]) {
    const entry = openRouterCapabilityEntry({ id: modelId }, input, output, {});
    assert.ok(entry);
    upsertSyncedCapabilities("openrouter", { [modelId]: entry });
  }

  discover(["text", "image"], ["text", "audio"]);
  const originalVersion = getModelCatalogCacheVersion();
  const original = getSyncedCapabilities("openrouter").openrouter[modelId];

  for (const { input, output } of [
    { input: ["image", "text"], output: ["text", "audio"] },
    { input: ["text", "image"], output: ["audio", "text"] },
    { input: ["image", "text", "image"], output: ["audio", "audio", "text"] },
  ]) {
    discover(input, output);
    assert.equal(
      getModelCatalogCacheVersion(),
      originalVersion,
      "equal modality sets must not invalidate the catalog"
    );
    assert.deepEqual(getSyncedCapabilities("openrouter").openrouter[modelId], original);
  }

  let previousVersion = originalVersion;
  for (const { input, output } of [
    { input: ["image", "text", "video"], output: ["audio", "text"] },
    { input: ["text", "video"], output: ["audio", "text"] },
    { input: ["text", "video"], output: ["audio", "text", "image"] },
    { input: ["text", "video"], output: ["text", "image"] },
  ]) {
    discover(input, output);
    const changedVersion = getModelCatalogCacheVersion();
    assert.notEqual(changedVersion, previousVersion, "effective modality changes must invalidate");
    previousVersion = changedVersion;
  }
});

test("legacy OpenRouter modality order and duplicates do not invalidate on discovery", () => {
  const modelId = "fixture/legacy-modality-sets";
  const incoming = openRouterCapabilityEntry(
    { id: modelId },
    ["image", "text"],
    ["audio", "text"],
    {}
  );
  assert.ok(incoming);
  const legacy = {
    ...incoming,
    // The persisted capability reader normalizes absent efforts to null.
    reasoning_efforts: null,
    modalities_input: '["text","image","text"]',
    modalities_output: '["text","audio","audio"]',
  };
  upsertSyncedCapabilities("openrouter", { [modelId]: legacy });
  const before = getModelCatalogCacheVersion();

  upsertSyncedCapabilities("openrouter", { [modelId]: incoming });
  assert.equal(getModelCatalogCacheVersion(), before, "equivalent legacy sets must not invalidate");
  assert.deepEqual(getSyncedCapabilities("openrouter").openrouter[modelId], legacy);

  upsertSyncedCapabilities("openrouter", {
    [modelId]: { ...incoming, limit_context: 16384 },
  });
  assert.notEqual(getModelCatalogCacheVersion(), before, "other semantic changes still invalidate");
  assert.equal(getSyncedCapabilities("openrouter").openrouter[modelId].limit_context, 16384);
});
