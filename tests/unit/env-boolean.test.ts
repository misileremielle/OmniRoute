import test from "node:test";
import assert from "node:assert/strict";

const { parseEnvBoolean } = await import("../../src/shared/utils/envBoolean.ts");

test("parseEnvBoolean accepts common truthy/falsy forms and fallbacks", () => {
  assert.equal(parseEnvBoolean(undefined, true), true);
  assert.equal(parseEnvBoolean("", false), false);
  assert.equal(parseEnvBoolean("true", false), true);
  assert.equal(parseEnvBoolean("TRUE", false), true);
  assert.equal(parseEnvBoolean("1", false), true);
  assert.equal(parseEnvBoolean("yes", false), true);
  assert.equal(parseEnvBoolean("on", false), true);
  assert.equal(parseEnvBoolean("false", true), false);
  assert.equal(parseEnvBoolean("FALSE", true), false);
  assert.equal(parseEnvBoolean("0", true), false);
  assert.equal(parseEnvBoolean("no", true), false);
  assert.equal(parseEnvBoolean("off", true), false);
  assert.equal(parseEnvBoolean("maybe", true), true);
  assert.equal(parseEnvBoolean("maybe", false), false);
});
