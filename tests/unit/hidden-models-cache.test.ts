import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hidden-models-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// getHiddenModelsByProvider() runs on every chat request and used to JSON.parse every
// customModels / modelCompatOverrides blob each time. It is now memoized on the
// model-catalog version; these pin the contract that makes that safe.
test("hidden-model snapshot is memoized, isolated per caller and busted by writes", async () => {
  await modelsDb.addCustomModel("openai", "gpt-hidden");
  modelsDb.setModelIsHidden("openai", "gpt-hidden", true);

  const first = modelsDb.getHiddenModelsByProvider("chat");
  assert.deepEqual([...(first.get("openai") ?? [])], ["gpt-hidden"]);

  // Callers (getHiddenChatModels) mutate the returned map; the cache must not see it.
  first.set("openai", new Set(["tampered"]));
  first.set("other", new Set(["x"]));
  const second = modelsDb.getHiddenModelsByProvider("chat");
  assert.deepEqual([...(second.get("openai") ?? [])], ["gpt-hidden"]);
  assert.equal(second.has("other"), false);

  // A raw write that skips the catalog write signal is not observed (proves the cache)...
  core
    .getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'customModels' AND key = 'openai'")
    .run();
  assert.equal(modelsDb.getHiddenModelsByProvider("chat").has("openai"), true);

  // ...while a write through the db module invalidates it at once.
  modelsDb.setModelIsHidden("anthropic", "claude-hidden", true);
  const fresh = modelsDb.getHiddenModelsByProvider("chat");
  assert.equal(fresh.has("openai"), false);
  assert.deepEqual([...(fresh.get("anthropic") ?? [])], ["claude-hidden"]);
});
