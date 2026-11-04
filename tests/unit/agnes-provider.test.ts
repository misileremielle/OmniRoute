import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agnes-provider-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
const { VIDEO_PROVIDER_IDS: _VIDEO_PROVIDER_IDS } =
  await import("../../src/shared/constants/providers.ts");
const { REGISTRY: providerRegistry, getRegistryModelThinkingEfforts } =
  await import("../../open-sse/config/providerRegistry.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { sanitizeReasoningEffortForProvider } =
  await import("../../open-sse/executors/base/reasoningEffort.ts");
const { getThinkingCapabilityFields } =
  await import("../../src/app/api/v1/models/catalogHelpers.ts");
const { resolveChatCoreTargetFormat } =
  await import("../../open-sse/handlers/chatCore/targetFormat.ts");
const { resolveModelAlias } = await import("../../open-sse/services/modelDeprecation.ts");
const dbCore = await import("../../src/lib/db/core.ts");

test.after(() => {
  dbCore.closeDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const AGNES_CHAT_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const AGNES_MODELS_URL = "https://apihub.agnes-ai.com/v1/models";
const AGNES_CN_BASE_URL = "https://api.agnes-ai.cn/v1";

test("agnes is registered as an API-key provider with complete metadata", () => {
  const entry = APIKEY_PROVIDERS.agnes;
  assert.ok(entry, "APIKEY_PROVIDERS.agnes must be defined");
  assert.equal(entry.id, "agnes");
  assert.equal(entry.alias, "agnes");
  assert.equal(entry.name, "Agnes AI");
  assert.equal(entry.icon, "auto_awesome");
  assert.equal(entry.color, "#10B981");
  assert.equal(entry.textIcon, "AG");
  assert.equal(entry.website, "https://agnes-ai.com");
  assert.equal(entry.hasFree, true);
  assert.ok(entry.freeNote, "freeNote must be defined");
  assert.ok(entry.authHint, "authHint must be defined");
});

test("agnes registry entry uses OpenAI Chat Completions format with bearer API-key auth", () => {
  const entry = providerRegistry.agnes;
  assert.ok(entry, "providerRegistry.agnes must be defined");
  assert.equal(entry.id, "agnes");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "default");
  assert.equal(entry.authType, "apikey");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.baseUrl, AGNES_CHAT_URL);
});

test("agnes routes Chat Completions clients through its OpenAI chat upstream", () => {
  const { targetFormat } = resolveChatCoreTargetFormat({
    provider: "agnes",
    resolvedModel: "agnes-2.5-flash",
    apiFormat: undefined,
    sourceFormat: "openai",
    customModelTargetFormat: undefined,
    providerSpecificData: null,
  });

  assert.equal(targetFormat, "openai");
  assert.equal(
    new DefaultExecutor("agnes").buildUrl("agnes-2.5-flash", true, 0, null),
    AGNES_CHAT_URL
  );
});

test("agnes ships the current public chat models with the correct capabilities", () => {
  const entry = providerRegistry.agnes;
  assert.deepEqual(
    entry.models.map((model) => model.id),
    ["agnes-2.0-flash", "agnes-2.5-flash", "agnes-3.0-flash"]
  );

  const flash20 = entry.models.find((m) => m.id === "agnes-2.0-flash");
  assert.ok(flash20, "agnes-2.0-flash must be defined");
  assert.equal(flash20.contextLength, 262144);
  assert.equal(flash20.maxOutputTokens, 65536);
  assert.equal(flash20.supportsReasoning, true);
  assert.deepEqual(flash20.supportedThinkingEfforts, ["none", "low", "medium", "high", "max"]);
  assert.equal(flash20.supportsVision, true);
  assert.equal(flash20.toolCalling, true);

  const flash25 = entry.models.find((m) => m.id === "agnes-2.5-flash");
  assert.ok(flash25, "agnes-2.5-flash must be defined");
  assert.equal(flash25.contextLength, 524288);
  assert.equal(flash25.maxOutputTokens, 65536);
  assert.equal(flash25.supportsReasoning, true);
  assert.deepEqual(flash25.supportedThinkingEfforts, ["none", "low", "medium", "high", "max"]);

  const flash30 = entry.models.find((m) => m.id === "agnes-3.0-flash");
  assert.ok(flash30, "agnes-3.0-flash must be defined");
  assert.equal(flash30.contextLength, 524288);
  assert.equal(flash30.maxOutputTokens, 65536);
  assert.equal(flash30.supportsReasoning, true);
  assert.deepEqual(flash30.supportedThinkingEfforts, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(flash30.supportsVision, true);
  assert.equal(flash30.toolCalling, true);
  assert.equal(flash30.interleavedField, "reasoning_content");
});

test("agnes chat models advertise official thinking vocabulary", () => {
  for (const id of ["agnes-2.0-flash", "agnes-2.5-flash"]) {
    assert.deepEqual(getRegistryModelThinkingEfforts("agnes", id), [
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  }
  assert.deepEqual(getRegistryModelThinkingEfforts("agnes", "agnes-3.0-flash"), [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("agnes catalog effort_tiers match declared vocabulary, not six-tier fallback", () => {
  const efforts = getRegistryModelThinkingEfforts("agnes", "agnes-3.0-flash");
  assert.ok(efforts && efforts.length > 0);
  assert.deepEqual(
    getThinkingCapabilityFields("agnes", "agnes-3.0-flash", true, efforts, !efforts.length),
    {
      thinking: true,
      supportsThinking: true,
      effort_tiers: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }
  );
});

test("agnes sanitizer keeps official tiers and clamps undocumented ones", () => {
  const clamp = (model: string, effort: string) =>
    (
      sanitizeReasoningEffortForProvider({ reasoning_effort: effort }, "agnes", model) as {
        reasoning_effort?: string;
      }
    ).reasoning_effort;

  assert.equal(clamp("agnes-3.0-flash", "none"), "none");
  assert.equal(clamp("agnes-3.0-flash", "minimal"), "minimal");
  assert.equal(clamp("agnes-3.0-flash", "low"), "low");
  assert.equal(clamp("agnes-3.0-flash", "high"), "high");
  assert.equal(clamp("agnes-3.0-flash", "xhigh"), "xhigh");
  assert.equal(clamp("agnes-3.0-flash", "max"), "max");
  assert.equal(clamp("agnes-3.0-flash", "ultra"), "max");
  assert.equal(clamp("agnes-3.0-flash", "off"), "none");

  // 2.0/2.5 reject xhigh (HTTP 400); clamp up to the next accepted tier (max).
  assert.equal(clamp("agnes-2.0-flash", "xhigh"), "max");
  assert.equal(clamp("agnes-2.5-flash", "xhigh"), "max");
  assert.equal(clamp("agnes-2.0-flash", "max"), "max");
  assert.equal(clamp("agnes-2.0-flash", "off"), "none");
  assert.equal(clamp("agnes-2.0-flash", "minimal"), "low");
  assert.equal(clamp("agnes-2.5-flash", "minimal"), "low");
  assert.equal(clamp("agnes-2.5-flash", "off"), "none");
});

test("agnes registry advertises the live OpenAI-style /models endpoint", () => {
  const entry = providerRegistry.agnes;
  assert.equal(entry.modelsUrl, AGNES_MODELS_URL);
});

test("agnes is classified for live OpenAI-style /models discovery", async () => {
  const { isNamedOpenAIStyleProvider } =
    await import("../../src/app/api/providers/[id]/models/discovery/providerSets.ts");
  assert.equal(isNamedOpenAIStyleProvider("agnes"), true);
});

test("agnes honors per-connection CN base URL override", () => {
  const url = new DefaultExecutor("agnes").buildUrl("agnes-3.0-flash", true, 0, {
    providerSpecificData: { baseUrl: AGNES_CN_BASE_URL },
  });
  assert.equal(url, `${AGNES_CN_BASE_URL}/chat/completions`);
});

test("agnes base-URL field is always-on so CN keys can point at api.agnes-ai.cn", async () => {
  const helpers =
    await import("../../src/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers.ts");
  assert.equal(helpers.isBaseUrlConfigurableProvider("agnes"), true);
  assert.equal(helpers.getProviderBaseUrlDefault("agnes"), "https://apihub.agnes-ai.com/v1");
  assert.equal(helpers.getProviderBaseUrlPlaceholder("agnes"), AGNES_CN_BASE_URL);
});

test("agnes-1.5-flash is retired and forwards to agnes-3.0-flash", () => {
  const entry = providerRegistry.agnes;
  assert.equal(
    entry.models.some((model) => model.id === "agnes-1.5-flash"),
    false
  );
  assert.equal(resolveModelAlias("agnes-1.5-flash", "agnes"), "agnes-3.0-flash");
});

test("agnes free catalog exposes the current free chat models through one shared pool", () => {
  const rows = FREE_MODEL_BUDGETS.filter((model) => model.provider === "agnes");
  assert.deepEqual(
    rows.map((model) => model.modelId),
    ["agnes-2.0-flash", "agnes-2.5-flash", "agnes-3.0-flash"]
  );
  assert.ok(rows.every((model) => model.poolKey === "agnes-free"));
});

test("agnes has no collision with zenmux-free sapiens-ai prefixed models", (t) => {
  const zenmux = providerRegistry["zenmux-free"];
  if (!zenmux) {
    t.skip("zenmux-free not registered in this environment");
    return;
  }
  const agnesInZenmux = zenmux.models.filter((m) => m.id.includes("agnes"));
  for (const m of agnesInZenmux) {
    assert.ok(
      m.id.startsWith("sapiens-ai/"),
      `zenmux agnes model ${m.id} must use sapiens-ai/ prefix to avoid collision`
    );
  }
});
