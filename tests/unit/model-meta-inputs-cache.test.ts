import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-meta-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const sseModelService = await import("../../src/sse/services/model.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// getModelInfo() -> lookupModelMeta() runs on every request and per combo target. Its
// inputs (customModels + the active synced catalog + compat overrides) are now memoized
// per provider on the model-catalog version. Writes through the db modules must still
// be visible on the very next request.
test("model metadata inputs are memoized and refreshed by catalog writes", async () => {
  await modelsDb.addCustomModel("openai", "my-custom-model", "My model", "manual", "responses");
  const first = await sseModelService.getModelInfo("openai/my-custom-model");
  assert.equal(first.apiFormat, "responses");

  // A raw delete skips the catalog write signal: still served from the memo.
  core
    .getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'customModels' AND key = 'openai'")
    .run();
  const cached = await sseModelService.getModelInfo("openai/my-custom-model");
  assert.equal(cached.apiFormat, "responses");

  // A write through the db module bumps the version → the next lookup is fresh.
  await modelsDb.addCustomModel("openai", "other-model", "Other", "manual", "chat-completions");
  const fresh = await sseModelService.getModelInfo("openai/my-custom-model");
  assert.equal(fresh.apiFormat, undefined);
});
