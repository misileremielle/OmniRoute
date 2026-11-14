import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-deepseek-efforts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "deepseek-efforts-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { sanitizeReasoningEffortForProvider } = await import("../../open-sse/executors/base.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("DeepSeek registries declare none/low/high/max on both V4 models", () => {
  const expectedEfforts = ["none", "low", "high", "max"];
  for (const providerId of ["deepseek", "opencode-go"]) {
    const models = new Map((REGISTRY[providerId]?.models || []).map((model) => [model.id, model]));
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      assert.deepEqual(models.get(modelId)?.supportedThinkingEfforts, expectedEfforts);
      for (const effort of expectedEfforts) {
        assert.equal(
          models.has(`${modelId}-${effort}`),
          false,
          `${providerId} should derive ${modelId}-${effort} from the base model metadata`
        );
      }
    }
  }
});

test("DeepSeek catalog exposes only the declared effort aliases", async () => {
  await providersDb.createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name: "deepseek-efforts",
    apiKey: "deepseek-test-key",
    isActive: true,
    testStatus: "active",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const ids = new Set(body.data.map((model) => model.id));

  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-none")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-low")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-high")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-max")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-none")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-low")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-high")));
  assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-max")));
});

test("OpenCode Go catalog derives the declared V4 effort aliases from base models", async () => {
  await providersDb.createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    name: "opencode-go-deepseek-efforts",
    apiKey: "opencode-go-test-key",
    isActive: true,
    testStatus: "active",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as {
    data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
  };
  const models = new Map(body.data.map((model) => [model.id, model]));
  const expectedEfforts = ["none", "low", "high", "max"];

  for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const baseId = `opencode-go/${modelId}`;
    assert.deepEqual(models.get(baseId)?.capabilities?.effort_tiers, expectedEfforts);
    for (const effort of expectedEfforts) {
      assert.ok(models.has(`${baseId}-${effort}`), `${baseId}-${effort} must be advertised`);
    }
    assert.equal(models.has(`${baseId}-medium`), false);
  }
});

test("hardcoded DeepSeek effort suffixes resolve through the static registry", async () => {
  const flashLow = await getModelInfo("ds/deepseek-v4-flash-low");
  assert.equal(flashLow.provider, "deepseek");
  assert.equal(flashLow.model, "deepseek-v4-flash");
  assert.equal(flashLow.resolvedThinkingEffort, "low");

  const flashNone = await getModelInfo("deepseek/deepseek-v4-flash-none");
  assert.equal(flashNone.model, "deepseek-v4-flash");
  assert.equal(flashNone.resolvedThinkingEffort, "none");

  const proLow = await getModelInfo("ds/deepseek-v4-pro-low");
  assert.equal(proLow.model, "deepseek-v4-pro");
  assert.equal(proLow.resolvedThinkingEffort, "low");
});

test("OpenCode Go V4 suffixes resolve from base-model effort metadata", async () => {
  for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    for (const effort of ["none", "low", "high", "max"]) {
      const info = await getModelInfo(`opencode-go/${modelId}-${effort}`);
      assert.equal(info.provider, "opencode-go");
      assert.equal(info.model, modelId);
      assert.equal(info.resolvedThinkingEffort, effort);
    }
  }
});

test("native DeepSeek preserves the documented low effort for Flash and Pro", () => {
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const body = { model, reasoning_effort: "low" };
    assert.equal(
      sanitizeReasoningEffortForProvider(body, "deepseek", model),
      body,
      `${model} must pass low through unchanged`
    );
  }
});

test("custom model named deepseek-v4-flash-low is not rewritten by registry suffix resolution", async () => {
  // A custom (DB) model literally named deepseek-v4-flash-low on the deepseek
  // provider must not be silently rewritten to deepseek-v4-flash + effort low,
  // which would drop its custom apiFormat/targetFormat metadata (#9485 review #3).
  await modelsDb.addCustomModel(
    "deepseek",
    "deepseek-v4-flash-low",
    "deepseek-v4-flash-low",
    "manual",
    "responses",
    ["chat"],
    "responses"
  );

  const info = await getModelInfo("ds/deepseek-v4-flash-low");
  // The model id should be preserved as the literal custom id, not rewritten
  assert.equal(info.model, "deepseek-v4-flash-low");
  // The custom apiFormat must survive (not dropped by registry rewriting)
  assert.equal(info.apiFormat, "responses");
  // No resolved effort should be injected — this is a distinct custom model
  assert.equal(info.resolvedThinkingEffort, undefined);
});

test("none effort resolves and stays explicit through provider sanitation", async () => {
  // The format translator subsequently carries this as reasoning.effort:"none"
  // on DeepSeek's default Responses route, which disables thinking.
  const flashNone = await getModelInfo("ds/deepseek-v4-flash-none");
  assert.equal(flashNone.model, "deepseek-v4-flash");
  assert.equal(flashNone.resolvedThinkingEffort, "none");

  const sanitized = sanitizeReasoningEffortForProvider(
    { model: "deepseek-v4-flash", reasoning_effort: "none" },
    "deepseek",
    "deepseek-v4-flash"
  ) as Record<string, unknown>;
  assert.equal(sanitized.reasoning_effort, "none");
});

test("suffixed Flash low remains valid before alias resolution", () => {
  // Preserve low even if a future route sanitizes the raw suffixed id before
  // resolving it to the registered base model.
  const sanitizedSuffixed = sanitizeReasoningEffortForProvider(
    { model: "deepseek-v4-flash-low", reasoning_effort: "low" },
    "deepseek",
    "deepseek-v4-flash-low"
  ) as Record<string, unknown>;
  assert.equal(sanitizedSuffixed.reasoning_effort, "low");
});
