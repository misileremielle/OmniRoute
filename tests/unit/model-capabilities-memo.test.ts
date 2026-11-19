// getResolvedModelCapabilities() memo (perf step 11, fix 1): a repeated snapshot-free
// resolution is served from memory until the model-catalog version moves, the DB
// instance changes, or 10 s pass; callers get copies; snapshot and limitSources
// calls always resolve fresh.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cap-memo-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const models = await import("../../src/lib/db/models.ts");
const caps = await import("../../src/lib/modelCapabilities.ts");
const snapshots = await import("../../src/lib/modelCapabilityResolutionSnapshot.ts");

const PROVIDER = "github";
const MODEL = "claude-opus-4.5";
const INPUT = { provider: PROVIDER, model: MODEL };

/** Write a context override straight into SQLite, without the version-bumping writer. */
function rawContextOverride(realContext: number): void {
  core
    .getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO model_context_overrides " +
        "(provider, model_id, real_context, source, refreshed_at) " +
        "VALUES (?, ?, ?, 'manual', datetime('now'))"
    )
    .run(PROVIDER, MODEL, realContext);
}

test.before(() => {
  core.resetDbInstance();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(() => {
  contextOverrides.removeModelContextOverride(PROVIDER, MODEL);
  caps.resetResolvedModelCapabilitiesCache();
});

test("a repeated resolution comes from the memo until a writer bumps the version", () => {
  const first = caps.getResolvedModelCapabilities(INPUT);
  assert.notEqual(first.contextWindow, 1_500_000);

  rawContextOverride(1_500_000);
  assert.equal(
    caps.getResolvedModelCapabilities(INPUT).contextWindow,
    first.contextWindow,
    "a write that bumps nothing is not seen: the memo answered"
  );

  assert.equal(contextOverrides.setModelContextOverride(PROVIDER, MODEL, 2_000_000), true);
  assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, 2_000_000);
});

test("a custom-model write clears the memo", async () => {
  caps.getResolvedModelCapabilities(INPUT);
  rawContextOverride(1_500_000);
  await models.addCustomModel(PROVIDER, "memo-test-custom-model");
  assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, 1_500_000);
});

test("entries expire after 10 s, for writes made by another process", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const first = caps.getResolvedModelCapabilities(INPUT);
    rawContextOverride(1_500_000);
    mock.timers.tick(9_000);
    assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, first.contextWindow);
    mock.timers.tick(1_001);
    assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, 1_500_000);
  } finally {
    mock.timers.reset();
  }
});

test("a new DB instance clears the memo", () => {
  caps.getResolvedModelCapabilities(INPUT);
  rawContextOverride(1_500_000);
  core.resetDbInstance();
  assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, 1_500_000);
});

test("callers get copies: editing a result does not change the next one", () => {
  const first = caps.getResolvedModelCapabilities(INPUT);
  const modalities = [...first.modalitiesInput];
  const context = first.contextWindow;
  first.modalitiesInput.push("edited");
  first.contextWindow = 1;
  const second = caps.getResolvedModelCapabilities(INPUT);
  assert.deepEqual(second.modalitiesInput, modalities);
  assert.equal(second.contextWindow, context);
  assert.notEqual(second, first);
});

test("limitSources calls resolve fresh", () => {
  caps.getResolvedModelCapabilities(INPUT);
  rawContextOverride(1_500_000);
  const withSources = caps.getResolvedModelCapabilitiesWithLimitSources(INPUT);
  assert.equal(withSources.capabilities.contextWindow, 1_500_000);
});

test("snapshot calls resolve fresh and do not fill the memo", () => {
  const first = caps.getResolvedModelCapabilities(INPUT);
  rawContextOverride(1_500_000);
  const snapshot = snapshots.createModelCapabilityResolutionSnapshot();
  assert.equal(
    caps.getResolvedModelCapabilities(INPUT, undefined, snapshot).contextWindow,
    1_500_000
  );
  assert.equal(
    caps.getResolvedModelCapabilities(INPUT).contextWindow,
    first.contextWindow,
    "the snapshot result did not replace the memoized one"
  );
});

test("ids containing a NUL get their own memo entries", () => {
  assert.equal(contextOverrides.setModelContextOverride("a\u0000b", "c", 30_303), true);
  assert.equal(contextOverrides.setModelContextOverride("a", "b\u0000c", 40_404), true);
  const first = caps.getResolvedModelCapabilities({ provider: "a\u0000b", model: "c" });
  const second = caps.getResolvedModelCapabilities({ provider: "a", model: "b\u0000c" });
  assert.equal(first.contextWindow, 30_303);
  assert.equal(second.contextWindow, 40_404);
});

test("persistedOverrides: false is memoized apart from the default", () => {
  assert.equal(contextOverrides.setModelContextOverride(PROVIDER, MODEL, 2_000_000), true);
  const plain = caps.getResolvedModelCapabilities(INPUT, { persistedOverrides: false });
  assert.notEqual(plain.contextWindow, 2_000_000);
  assert.equal(caps.getResolvedModelCapabilities(INPUT).contextWindow, 2_000_000);
  assert.equal(
    caps.getResolvedModelCapabilities(INPUT, { persistedOverrides: false }).contextWindow,
    plain.contextWindow
  );
});
