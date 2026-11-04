/**
 * #6135: providers flagged system-message-must-be-first reject a `system` message at any
 * index other than 0, so the strict hoist has to know exactly which providers those are.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  systemMessageMustBeFirst,
  parseStrictSystemProvidersEnv,
} from "../../open-sse/translator/helpers/strictSystemHoist.ts";

describe("OMNIROUTE_STRICT_SYSTEM_PROVIDERS env override", () => {
  it("is a no-op when unset or empty", () => {
    assert.deepEqual(parseStrictSystemProvidersEnv({}), []);
    assert.deepEqual(parseStrictSystemProvidersEnv({ OMNIROUTE_STRICT_SYSTEM_PROVIDERS: "" }), []);
    assert.equal(systemMessageMustBeFirst("coding-agent", {}), false);
  });

  it("extends the built-in set without removing xiaomi-mimo/mimo", () => {
    const env = { OMNIROUTE_STRICT_SYSTEM_PROVIDERS: "coding-agent" };
    assert.equal(systemMessageMustBeFirst("coding-agent", env), true);
    assert.equal(systemMessageMustBeFirst("xiaomi-mimo", env), true);
    assert.equal(systemMessageMustBeFirst("mimo", env), true);
    assert.equal(systemMessageMustBeFirst("anthropic", env), false);
  });

  it("is case-insensitive and trims whitespace around comma-separated ids", () => {
    const env = { OMNIROUTE_STRICT_SYSTEM_PROVIDERS: " Coding-Agent , My-Backend  " };
    assert.deepEqual(parseStrictSystemProvidersEnv(env), ["coding-agent", "my-backend"]);
    assert.equal(systemMessageMustBeFirst("CODING-AGENT", env), true);
    assert.equal(systemMessageMustBeFirst("my-backend", env), true);
  });

  it("ignores empty entries from stray/trailing commas", () => {
    const env = { OMNIROUTE_STRICT_SYSTEM_PROVIDERS: "coding-agent,,  ,my-backend," };
    assert.deepEqual(parseStrictSystemProvidersEnv(env), ["coding-agent", "my-backend"]);
  });
});
