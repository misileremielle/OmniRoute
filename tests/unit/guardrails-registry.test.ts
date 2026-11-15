import test from "node:test";
import assert from "node:assert/strict";

import {
  BaseGuardrail,
  CredentialMaskerGuardrail,
  GuardrailRegistry,
  resolveDisabledGuardrails,
} from "../../src/lib/guardrails/index.ts";

test("guardrail registry runs pre-call hooks in priority order", async () => {
  class AppendGuardrail extends BaseGuardrail {
    private readonly marker: string;

    constructor(name: string, priority: number, marker: string) {
      super(name, { priority });
      this.marker = marker;
    }

    override async preCall(payload: unknown) {
      const record = payload as Record<string, unknown>;
      const markers = Array.isArray(record.markers) ? [...record.markers] : [];
      markers.push(this.marker);
      return {
        modifiedPayload: {
          ...record,
          markers,
        },
      };
    }
  }

  const registry = new GuardrailRegistry();
  registry.register(new AppendGuardrail("later", 30, "later"));
  registry.register(new AppendGuardrail("earlier", 10, "earlier"));

  const result = await registry.runPreCallHooks({ markers: [] });

  assert.equal(result.blocked, false);
  assert.deepEqual((result.payload as Record<string, unknown>).markers, ["earlier", "later"]);
});

test("guardrail registry respects disabledGuardrails from context", async () => {
  const registry = new GuardrailRegistry();
  registry.register(new CredentialMaskerGuardrail());

  const result = await registry.runPreCallHooks(
    { safe: true },
    { disabledGuardrails: ["credential-masker"] }
  );

  assert.equal(result.blocked, false);
  assert.equal(result.results[0]?.skipped, true);
});

test("resolveDisabledGuardrails merges api key, body metadata, and headers", () => {
  const disabled = resolveDisabledGuardrails({
    apiKeyInfo: { disabledGuardrails: ["credential-masker"] },
    body: { metadata: { disabledGuardrails: ["vision_bridge"] } },
    headers: { "x-omniroute-disabled-guardrails": "custom-rule" },
  });

  assert.deepEqual(disabled, ["credential-masker", "vision-bridge", "custom-rule"]);
});

test("guardrail registry fails open when a guardrail throws", async () => {
  class ExplodingGuardrail extends BaseGuardrail {
    constructor() {
      super("exploding", { priority: 5 });
    }

    override async preCall() {
      throw new Error("boom");
    }
  }

  const warnings: Array<Record<string, unknown>> = [];
  const registry = new GuardrailRegistry();
  registry.register(new ExplodingGuardrail());

  const result = await registry.runPreCallHooks(
    { safe: true },
    {
      log: {
        warn: (_tag, _message, meta) => warnings.push(meta || {}),
      },
    }
  );

  assert.equal(result.blocked, false);
  assert.equal((result.payload as Record<string, unknown>).safe, true);
  assert.equal(result.results[0]?.error, "boom");
  assert.equal(warnings.length, 1);
});

test("guardrail registry never fails open after the client request aborts", async () => {
  class AbortedGuardrail extends BaseGuardrail {
    constructor() {
      super("aborted", { priority: 5 });
    }

    override async preCall() {
      throw new Error("private downstream abort detail");
    }
  }

  const controller = new AbortController();
  controller.abort();
  const registry = new GuardrailRegistry();
  registry.register(new AbortedGuardrail());
  await assert.rejects(
    () => registry.runPreCallHooks({ safe: true }, { signal: controller.signal }),
    /Guardrail processing aborted/
  );
});
