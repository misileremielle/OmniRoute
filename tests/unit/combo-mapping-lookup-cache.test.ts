import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-mapping-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const mappingsDb = await import("../../src/lib/db/modelComboMappings.ts");
const sseModelService = await import("../../src/sse/services/model.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// getComboForModel() runs for every non-combo model on every chat request. Its
// pattern-mapping step used the raw resolveComboForModel() (JOIN + one glob RegExp
// compile per mapping row + combo JSON parse) although a version-keyed cache already
// existed. It must now be served from that cache and still see mapping writes at once.
test("getComboForModel serves pattern mappings from the version-keyed cache", async () => {
  const combo = await combosDb.createCombo({ name: "mapped-combo", models: ["openai/gpt-4o"] });
  const mapping = await mappingsDb.createModelComboMapping({
    pattern: "gpt-*",
    comboId: String(combo.id),
  });

  const first = await sseModelService.getComboForModel("gpt-5-mini");
  assert.equal(first?.name, "mapped-combo");

  // A raw delete bypasses invalidation: a cached lookup keeps answering.
  core.getDbInstance().prepare("DELETE FROM model_combo_mappings WHERE id = ?").run(mapping.id);
  const cached = await sseModelService.getComboForModel("gpt-5-mini");
  assert.equal(cached?.name, "mapped-combo");

  // A write through the db module bumps the combo cache version → fresh lookup.
  await mappingsDb.createModelComboMapping({ pattern: "claude-*", comboId: String(combo.id) });
  assert.equal(await sseModelService.getComboForModel("gpt-5-mini"), null);
  assert.equal((await sseModelService.getComboForModel("claude-x"))?.name, "mapped-combo");
});
