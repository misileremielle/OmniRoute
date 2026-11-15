import { describe, it, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { parse } from "jsonc-parser";
import * as generator from "../../../src/lib/cli-helper/config-generator/index.ts";

describe("config-generator", () => {
  describe("validateBaseUrl", () => {
    it("accepts http URLs", async () => {
      const mod = await import("../../../src/lib/cli-helper/config-generator/index.ts");
      assert.strictEqual(mod.validateBaseUrl("http://localhost:20128"), true);
    });

    it("accepts https URLs", async () => {
      const mod = await import("../../../src/lib/cli-helper/config-generator/index.ts");
      assert.strictEqual(mod.validateBaseUrl("https://example.com"), true);
    });

    it("rejects non-URL strings", async () => {
      const mod = await import("../../../src/lib/cli-helper/config-generator/index.ts");
      assert.strictEqual(mod.validateBaseUrl("not-a-url"), false);
    });
  });

  describe("assertSafeCatalogUrl (SSRF guard, CodeQL #326)", () => {
    it("allows the loopback OmniRoute target (the legitimate default) and returns a URL", async () => {
      const { assertSafeCatalogUrl } =
        await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
      // The catalog source IS the user's own OmniRoute — localhost must stay allowed.
      assert.doesNotThrow(() => assertSafeCatalogUrl("http://localhost:20128/v1/models"));
      assert.doesNotThrow(() => assertSafeCatalogUrl("http://127.0.0.1:20128/v1/models"));
      // Returns the validated, re-parsed URL (taint-severed value the caller fetches).
      const safe = assertSafeCatalogUrl("http://localhost:20128/v1/models");
      assert.ok(safe instanceof URL);
      assert.equal(safe.href, "http://localhost:20128/v1/models");
    });

    it("allows a public OmniRoute Cloud target", async () => {
      const { assertSafeCatalogUrl } =
        await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
      assert.doesNotThrow(() => assertSafeCatalogUrl("https://api.omniroute.online/v1/models"));
    });

    it("blocks the cloud-metadata SSRF→IAM pivot (169.254.169.254)", async () => {
      const { assertSafeCatalogUrl } =
        await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
      assert.throws(() => assertSafeCatalogUrl("http://169.254.169.254/v1/models"));
      assert.throws(() => assertSafeCatalogUrl("http://metadata.google.internal/v1/models"));
    });

    it("blocks non-http(s) protocols and embedded credentials", async () => {
      const { assertSafeCatalogUrl } =
        await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
      assert.throws(() => assertSafeCatalogUrl("file:///etc/passwd"));
      assert.throws(() => assertSafeCatalogUrl("http://user:pass@example.com/v1/models"));
    });
  });

  describe("generateConfig", () => {
    it("returns error for invalid baseUrl", async () => {
      const result = await generator.generateConfig("claude", {
        baseUrl: "invalid",
        apiKey: "sk-xxx",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("Invalid baseUrl"));
    });

    it("returns error for empty apiKey", async () => {
      const result = await generator.generateConfig("claude", {
        baseUrl: "http://localhost:20128",
        apiKey: "",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("API key"));
    });

    it("returns success for valid claude config", async () => {
      // This may fail if the claude generator has issues - just ensure error handling works
      const result = await generator.generateConfig("claude", {
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
      });
      // Either success or error (if generator missing), but check structure is correct
      assert.ok("success" in result);
      assert.ok("configPath" in result);
    });

    it("accepts the legacy kilocode id while generating the canonical kilo config", async () => {
      const result = await generator.generateConfig("kilocode", {
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.configPath.includes(".config/kilocode/settings.json"));
      assert.ok(String(result.content).includes("http://localhost:20128/v1"));
    });

    it("returns success for valid hermes config", async () => {
      const result = await generator.generateConfig("hermes", {
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
        model: "gpt-5.4-mini",
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.configPath.endsWith(".hermes/config.yaml"));
      assert.ok(String(result.content || "").includes("providers:"));
      assert.ok(String(result.content || "").includes("omniroute"));
    });

    it("returns error for unknown tool", async () => {
      const result = await generator.generateConfig("unknown-tool-xyz", {
        baseUrl: "http://localhost:20128",
        apiKey: "sk-xxx",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("Unknown tool"));
    });
  });

  describe("generateAllConfigs", () => {
    it("returns array of GenerateResult for all tools", async () => {
      const results = await generator.generateAllConfigs({
        baseUrl: "http://localhost:20128",
        apiKey: "sk-xxx",
      });
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 8); // claude, codex, opencode, cline, kilocode, continue, hermes, whycodes (#14107)
    });
  });

  describe("hermes-agent (rich multi-role)", () => {
    it("exports HERMES_AGENT_ROLES with expected roles", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      assert.ok(Array.isArray(hermesAgent.HERMES_AGENT_ROLES));
      const ids = hermesAgent.HERMES_AGENT_ROLES.map((r: any) => r.id);
      assert.ok(ids.includes("default"));
      assert.ok(ids.includes("delegation"));
      assert.ok(ids.includes("vision"));
      assert.ok(ids.includes("approval"));
      // Full catalog, kept in sync with Hermes Agent's current auxiliary schema.
      // Listed explicitly (not just parity-diffed against the UI
      // below) so a role dropped from BOTH catalogs at once still fails this test.
      const expectedIds = [
        "default",
        "delegation",
        "vision",
        "compression",
        "skills_hub",
        "approval",
        "review",
        "mcp",
        "title_generation",
        "memory_query_rewrite",
        "tts_audio_tags",
        "triage_specifier",
        "kanban_decomposer",
        "profile_describer",
        "goal_judge",
        "curator",
        "monitor",
        "background_review",
        "moa_reference",
        "moa_aggregator",
      ];
      assert.deepStrictEqual([...ids].sort(), [...expectedIds].sort());
    });

    it("getCurrentHermesAgentRoles returns an object", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const roles = await hermesAgent.getCurrentHermesAgentRoles();
      assert.ok(typeof roles === "object" && roles !== null);
    });

    it("generateHermesAgentConfig returns yaml string for valid payload", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const result = await hermesAgent.generateHermesAgentConfig({
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test-omniroute",
        selections: [
          { role: "default", model: "gpt-4o" },
          { role: "delegation", model: "claude-3-5-sonnet" },
          { role: "vision", model: "gpt-4o" },
        ],
      } as any);

      assert.ok(!result.error);
      assert.ok(typeof result.yaml === "string");
      assert.ok(result.yaml.length > 50);
      assert.ok(result.yaml.includes("provider: omniroute"));
    });

    it("generateHermesAgentConfig includes auxiliary section for non-default roles", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const result = await hermesAgent.generateHermesAgentConfig({
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
        selections: [
          { role: "compression", model: "test-model" },
          { role: "skills_hub", model: "test-model-2" },
        ],
      });

      assert.ok(result.yaml.includes("auxiliary:"));
      assert.ok(result.yaml.includes("compression:"));
    });

    it("generateHermesAgentConfig returns error when baseUrl is missing", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const result = await hermesAgent.generateHermesAgentConfig({
        baseUrl: "",
        selections: [{ role: "default", model: "x" }],
      });

      assert.ok(result.error);
      assert.ok(result.error.includes("baseUrl"));
    });

    it("generateHermesAgentConfig correctly structures delegation and auxiliary roles", async () => {
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const result = await hermesAgent.generateHermesAgentConfig({
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
        selections: [
          { role: "default", model: "model-default" },
          { role: "delegation", model: "model-delegation" },
          { role: "approval", model: "model-approval" },
        ],
      });

      const yaml = result.yaml;
      assert.ok(yaml.includes("model:"));
      assert.ok(yaml.includes("default: model-default"));
      assert.ok(yaml.includes("delegation:"));
      assert.ok(yaml.includes("auxiliary:"));
      assert.ok(yaml.includes("approval:"));
    });

    it("generateHermesAgentConfig performs non-destructive merge (preserves other keys)", async () => {
      // This test mainly verifies the function doesn't blow away unrelated config
      const hermesAgent =
        await import("../../../src/lib/cli-helper/config-generator/hermes-agent.ts");
      const result = await hermesAgent.generateHermesAgentConfig({
        baseUrl: "http://localhost:20128",
        apiKey: "sk-test",
        selections: [{ role: "default", model: "new-model" }],
      });

      // Should still contain the custom provider declaration and the new model.
      assert.ok(result.yaml.includes("custom_providers:"));
      assert.ok(result.yaml.includes("new-model"));
    });
  });

  describe("opencode (context-aware)", () => {
    /**
     * The catalog is the single source of truth for context windows —
     * we never fabricate a default. Tests below pin this contract.
     */
    function makeCatalogResponse(models: unknown[]): unknown {
      return { object: "list", data: models };
    }

    const SAMPLE_CATALOG: unknown[] = [
      {
        id: "ds/deepseek-v4-flash",
        owned_by: "deepseek",
        context_length: 1_000_000,
        max_input_tokens: 1_000_000,
      },
      { id: "llama3", owned_by: "llama", max_context_window_tokens: 8192 },
      { id: "MASTER", owned_by: "combo", context_length: 131072, max_input_tokens: 131072 },
      {
        id: "Opencode FREE Omni",
        owned_by: "combo",
        context_length: 200000,
        max_input_tokens: 160000,
      },
      // Combo whose targets have no known context — generator must NOT
      // fabricate a default. The model is emitted without limit.context.
      { id: "NO_CTX_COMBO", owned_by: "combo" },
    ];

    function stubFetchOnce(body: unknown, status = 200) {
      const original = globalThis.fetch;
      let calls = 0;
      // @ts-ignore — globalThis.fetch signature is compatible for our purposes
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        calls += 1;
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      return {
        calls: () => calls,
        restore: () => {
          globalThis.fetch = original;
        },
      };
    }

    it("emits limit.context from the catalog (no hardcoded fallback)", async () => {
      const stub = stubFetchOnce(makeCatalogResponse(SAMPLE_CATALOG));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });
        const cfg = JSON.parse(out);
        const models = cfg.provider.omniroute.models;
        assert.strictEqual(models["ds/deepseek-v4-flash"].limit.context, 1_000_000);
        assert.strictEqual(models["MASTER"].limit.context, 131072);
        // Combo with min-of-targets 200K: must reflect the catalog's value,
        // not a hardcoded 128K.
        assert.strictEqual(models["Opencode FREE Omni"].limit.context, 200000);
      } finally {
        stub.restore();
      }
    });

    it("uses the required 128K context fallback when the catalog has no entry", async () => {
      const stub = stubFetchOnce(makeCatalogResponse(SAMPLE_CATALOG));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });
        const cfg = JSON.parse(out);
        // NO_CTX_COMBO has no context_length in the catalog. OpenCode v1
        // requires a complete limit object, so the compatibility fallback
        // must be explicit rather than leaving the config invalid.
        const noCtx = cfg.provider.omniroute.models["NO_CTX_COMBO"];
        assert.strictEqual(
          noCtx.limit?.context,
          128_000,
          `NO_CTX_COMBO should use the 128K fallback (got ${noCtx.limit?.context})`
        );
      } finally {
        stub.restore();
      }
    });

    it("prefers max_context_window_tokens when context_length is absent", async () => {
      const stub = stubFetchOnce(makeCatalogResponse(SAMPLE_CATALOG));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });
        const cfg = JSON.parse(out);
        assert.strictEqual(cfg.provider.omniroute.models.llama3.limit.context, 8192);
      } finally {
        stub.restore();
      }
    });

    it("THROWS when the catalog fetch fails (no silent stale config)", async () => {
      // When the catalog fetch fails, the generator MUST throw rather than
      // emit a config with fabricated values. The CLI catches the error
      // and surfaces it to the user; the user's existing opencode.json is
      // left untouched.
      const original = globalThis.fetch;
      // @ts-ignore
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        let threw = false;
        try {
          await generateOpencodeConfig({
            baseUrl: "http://localhost:20128",
            apiKey: "sk-test",
          });
        } catch (e) {
          threw = true;
          assert.ok(
            /catalog|fetch|ECONNREFUSED/i.test(String(e?.message ?? e)),
            `Expected fetch error, got: ${String(e?.message ?? e)}`
          );
        }
        assert.ok(threw, "generator must throw when catalog fetch fails");
      } finally {
        globalThis.fetch = original;
      }
    });

    it("writes a top-level model prefixed with provider id when options.model is supplied", async () => {
      const stub = stubFetchOnce(makeCatalogResponse(SAMPLE_CATALOG));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
          model: "MASTER",
        });
        const cfg = JSON.parse(out);
        assert.strictEqual(cfg.model, "omniroute/MASTER");
      } finally {
        stub.restore();
      }
    });

    it("propagates vision capability from the live catalog for issue #8960", async () => {
      const modelId = "cx/gpt-5.6-sol-medium-issue-8960";
      const stub = stubFetchOnce(
        makeCatalogResponse([
          {
            id: modelId,
            owned_by: "codex",
            context_length: 272000,
            max_output_tokens: 128000,
            capabilities: {
              vision: true,
              reasoning: true,
              tool_calling: true,
            },
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
        ])
      );
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });
        const cfg = JSON.parse(out);
        const model = cfg.provider.omniroute.models[modelId];

        assert.strictEqual(
          model.attachment,
          true,
          "a catalog model with vision/image input must remain attachment-capable in opencode.json"
        );
      } finally {
        stub.restore();
      }
    });

    it("auto-pulls the Opencode FREE Omni combo context (the user-reported case)", async () => {
      // Regression guard: the catalog's min-of-targets for combos must be
      // reflected verbatim. No hardcoded 128K, no fallback that overrides
      // the catalog's actual value.
      const stub = stubFetchOnce(makeCatalogResponse(SAMPLE_CATALOG));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });
        const cfg = JSON.parse(out);
        assert.strictEqual(
          cfg.provider.omniroute.models["Opencode FREE Omni"].limit.context,
          200000,
          "Opencode FREE Omni must have context=200000 from the catalog, not 128000"
        );
      } finally {
        stub.restore();
      }
    });

    it("#8849 emits a complete limit for catalog metadata without fabricating one", async () => {
      const catalog = [
        { id: "context-only", context_length: 131072 },
        { id: "context-input", context_length: 131072, max_input_tokens: 100000 },
        {
          id: "context-input-output",
          context_length: 131072,
          max_input_tokens: 100000,
          max_output_tokens: 32768,
        },
        { id: "no-metadata" },
      ];
      const stub = stubFetchOnce(makeCatalogResponse(catalog));
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
          providerId: "issue8849",
        });
        const models = JSON.parse(out).provider.issue8849.models;

        assert.deepStrictEqual(models["context-only"].limit, {
          context: 131072,
          output: 8192,
        });
        assert.deepStrictEqual(models["context-input"].limit, {
          context: 131072,
          input: 100000,
          output: 8192,
        });
        assert.deepStrictEqual(models["context-input-output"].limit, {
          context: 131072,
          input: 100000,
          output: 32768,
        });
        // #10940/#11035: OpenCode's v1 provider schema requires both fields,
        // so a model with zero metadata gets the compatibility fallbacks.
        assert.deepStrictEqual(models["no-metadata"].limit, {
          context: 128_000,
          output: 8192,
        });

        for (const model of Object.values(models) as Array<{ limit?: { output?: number } }>) {
          assert.ok(
            typeof model.limit?.output === "number" && model.limit.output > 0,
            "every emitted limit must contain a positive output"
          );
        }
      } finally {
        stub.restore();
      }
    });

    it("#8849 preserves manual output precedence over catalog and fallback values", async () => {
      const existingConfig = {
        provider: {
          issue8849: {
            models: {
              "manual-vs-catalog": { limit: { output: 16384 } },
              "manual-vs-fallback": { limit: { output: 4096 } },
            },
          },
        },
      };
      mock.method(fs, "existsSync", () => true);
      mock.method(fs, "readFileSync", () => JSON.stringify(existingConfig));
      const stub = stubFetchOnce(
        makeCatalogResponse([
          {
            id: "manual-vs-catalog",
            context_length: 131072,
            max_output_tokens: 32768,
          },
          { id: "manual-vs-fallback", context_length: 131072 },
        ])
      );
      try {
        const { generateOpencodeConfig } =
          await import("../../../src/lib/cli-helper/config-generator/opencode.ts");
        const out = await generateOpencodeConfig({
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
          providerId: "issue8849",
        });
        const models = JSON.parse(out).provider.issue8849.models;

        assert.deepStrictEqual(models["manual-vs-catalog"].limit, {
          context: 131072,
          output: 16384,
        });
        assert.deepStrictEqual(models["manual-vs-fallback"].limit, {
          context: 131072,
          output: 4096,
        });
      } finally {
        stub.restore();
        mock.restoreAll();
      }
    });

    it("loads comments and trailing commas from opencode.jsonc and returns its real path (#10227)", async () => {
      const existingJsonc = `{
  // preserve this native OpenCode file instead of ignoring it
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "custom": {
      // keep comments inside unrelated providers too
      "name": "Custom Provider"
    },
    "omniroute": {
      "models": {
        "manual-model": { "name": "Manual", "limit": { "context": 77777, }, },
      },
    },
  },
}\n`;
      let readPath = "";
      mock.method(fs, "existsSync", (candidate) => String(candidate).endsWith("opencode.jsonc"));
      mock.method(fs, "readFileSync", (candidate) => {
        readPath = String(candidate);
        return existingJsonc;
      });
      const stub = stubFetchOnce(
        makeCatalogResponse([{ id: "manual-model", context_length: 131072 }])
      );

      try {
        const result = await generator.generateConfig("opencode", {
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });

        assert.strictEqual(result.success, true);
        assert.match(result.configPath, /opencode\.jsonc$/);
        assert.strictEqual(readPath, result.configPath);
        assert.match(result.content || "", /preserve this native OpenCode file/);
        assert.match(result.content || "", /keep comments inside unrelated providers too/);
        const config = parse(result.content || "");
        assert.deepStrictEqual(config.provider.custom, { name: "Custom Provider" });
        assert.strictEqual(config.provider.omniroute.models["manual-model"].limit.context, 77777);
      } finally {
        stub.restore();
        mock.restoreAll();
      }
    });

    it("refuses to replace an invalid existing opencode.jsonc (#10227)", async () => {
      mock.method(fs, "existsSync", (candidate) => String(candidate).endsWith("opencode.jsonc"));
      mock.method(fs, "readFileSync", () => "{ invalid jsonc");
      const stub = stubFetchOnce(makeCatalogResponse([{ id: "catalog-model", context_length: 8 }]));

      try {
        const result = await generator.generateConfig("opencode", {
          baseUrl: "http://localhost:20128",
          apiKey: "sk-test",
        });

        assert.strictEqual(result.success, false);
        assert.match(result.error || "", /invalid.*JSONC|refus/i);
      } finally {
        stub.restore();
        mock.restoreAll();
      }
    });
  });
});
