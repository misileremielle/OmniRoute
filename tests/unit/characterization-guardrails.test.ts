// Characterization tests — src/lib/guardrails.
//
// Pins the public surface of the guardrails barrel and the observable behavior of its most
// used entry points (default registry wiring, credential-masker opt-in, fail-open dispatch)
// as they are TODAY. Uses test-local guardrails (or the kept credential-masker) for
// dispatch coverage so the file does not depend on any removed guardrail.
import test from "node:test";
import assert from "node:assert/strict";
import "../_setup/isolateDataDir.ts";

process.env.DISABLE_SQLITE_AUTO_BACKUP ||= "true";
for (const name of ["CREDENTIAL_REDACTION_ENABLED"]) {
  delete process.env[name];
}

const core = await import("../../src/lib/db/core.ts");
const { clearAllFeatureFlagOverrides } = await import("../../src/lib/db/featureFlags.ts");
const guardrails = await import("../../src/lib/guardrails/index.ts");

const {
  BaseGuardrail,
  GuardrailRegistry,
  CredentialMaskerGuardrail,
  resolveDisabledGuardrails,
  guardrailRegistry,
} = guardrails;

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function chatPayload() {
  return {
    model: "test-model",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is the capital of France?" },
    ],
  };
}

test.before(() => {
  clearAllFeatureFlagOverrides();
});

test.after(() => {
  core.resetDbInstance();
});

// ─── (a) Public surface snapshot ─────────────────────────────────────────────

test("guardrails barrel (src/lib/guardrails/index.ts) exports exactly this surface", () => {
  assert.deepEqual(Object.keys(guardrails).sort(), [
    "BaseGuardrail",
    "CREDENTIAL_PATTERNS",
    "CredentialMaskerGuardrail",
    "GuardrailRegistry",
    "guardrailRegistry",
    "redactCredentials",
    "registerDefaultGuardrails",
    "resetGuardrailsForTests",
    "resolveDisabledGuardrails",
  ]);
});

test("importing the barrel registers the two default guardrails in priority order", () => {
  assert.deepEqual(
    guardrailRegistry.list().map((g) => [g.name, g.priority, g.enabled]),
    [
      ["vision-bridge", 5, true],
      ["credential-masker", 9, true],
    ]
  );
});

// ─── (b) Entry-point contracts ───────────────────────────────────────────────

test("credential-masker through a registry with the flag OFF: passed, not modified, same payload reference", async () => {
  const registry = new GuardrailRegistry();
  registry.register(new CredentialMaskerGuardrail());
  const payload = chatPayload();

  const outcome = await registry.runPreCallHooks(payload, { log: silentLog });
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.payload, payload);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].guardrail, "credential-masker");
  assert.equal(outcome.results[0].modified, false);
  assert.equal(outcome.results[0].skipped, false);
  assert.equal(outcome.results[0].stage, "pre");
});

test("credential-masker is OFF by default (no settings flag, no env)", async () => {
  const guard = new CredentialMaskerGuardrail();
  const payload = {
    messages: [{ role: "user", content: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }],
  };
  assert.deepEqual(await guard.preCall(payload, {}), { block: false });
  assert.deepEqual(await guard.postCall(payload, {}), { block: false });
});

test("registry dispatch: a blocking guardrail short-circuits and later guardrails never run", async () => {
  const calls: string[] = [];
  class Blocker extends BaseGuardrail {
    async preCall() {
      calls.push(this.name);
      return { block: true, message: "nope" };
    }
  }
  class Recorder extends BaseGuardrail {
    async preCall() {
      calls.push(this.name);
      return { block: false };
    }
  }
  const registry = new GuardrailRegistry();
  registry.register(new Recorder("late", { priority: 50 }));
  registry.register(new Blocker("early", { priority: 1 }));

  const outcome = await registry.runPreCallHooks({ x: 1 }, { log: silentLog });
  assert.deepEqual(calls, ["early"]);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.guardrail, "early");
  assert.equal(outcome.message, "nope");
});

test("registry dispatch: disabled guardrails are skipped (names normalized), modifications chain", async () => {
  class Appender extends BaseGuardrail {
    async preCall(payload: unknown) {
      return { modifiedPayload: { ...(payload as object), [this.name]: true } };
    }
  }
  const registry = new GuardrailRegistry();
  registry.register(new Appender("first-step", { priority: 1 }));
  registry.register(new Appender("second-step", { priority: 2 }));

  const outcome = await registry.runPreCallHooks(
    { base: true },
    { log: silentLog, disabledGuardrails: ["Second_Step"] }
  );
  assert.deepEqual(outcome.payload, { base: true, "first-step": true });
  assert.deepEqual(
    outcome.results.map((r) => [r.guardrail, r.modified, r.skipped]),
    [
      ["first-step", true, false],
      ["second-step", false, true],
    ]
  );
});

test("resolveDisabledGuardrails merges apiKey, body, metadata and header sources (deduped)", () => {
  assert.deepEqual(
    resolveDisabledGuardrails({
      apiKeyInfo: { disabledGuardrails: ["Credential Masker"] },
      body: {
        disabledGuardrails: "custom_rule",
        metadata: { disabledGuardrails: ["credential-masker"] },
      },
      headers: { "X-OmniRoute-Disabled-Guardrails": "vision-bridge, credential-masker" },
    }),
    ["credential-masker", "custom-rule", "vision-bridge"]
  );
  assert.deepEqual(resolveDisabledGuardrails({}), []);
});

// ─── (c) Invalid input — current behavior ────────────────────────────────────

test("GuardrailRegistry.register rejects objects that do not extend BaseGuardrail", () => {
  const registry = new GuardrailRegistry();
  assert.throws(
    () => registry.register({ name: "duck", priority: 1, enabled: true } as never),
    /Guardrail must extend BaseGuardrail/
  );
});

test("registering a guardrail with an existing (normalized) name replaces it", () => {
  const registry = new GuardrailRegistry();
  registry.register(new BaseGuardrail("my-guard", { priority: 1 }));
  registry.register(new BaseGuardrail("My_Guard", { priority: 2 }));
  assert.deepEqual(
    registry.list().map((g) => [g.name, g.priority]),
    [["My_Guard", 2]]
  );
});
