import assert from "node:assert/strict";
import test from "node:test";

const { selectCoreTests } = await import("../../scripts/test/run-unit-core.mjs");

test("the core unit run selects the core areas and nothing from UI, docs or build", () => {
  const files: string[] = selectCoreTests();
  assert.ok(files.length > 100, `expected a substantial core set, got ${files.length}`);
  assert.ok(files.some((f) => f.startsWith("tests/unit/authz/")));
  assert.ok(files.some((f) => f.startsWith("tests/unit/combo/")));
  assert.ok(files.includes("tests/unit/chat-empty-stream-recovery.test.ts"));
  for (const f of files) {
    assert.match(f, /^tests\/unit\/.+\.test\.ts$/);
    assert.doesNotMatch(f, /^tests\/unit\/(ui|docs|build|dashboard|cli|serial)\//);
  }
  assert.equal(new Set(files).size, files.length, "no duplicates");
});
