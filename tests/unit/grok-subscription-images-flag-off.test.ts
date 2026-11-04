import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "omniroute-grok-images-off-"));
delete process.env.GROK_SUBSCRIPTION_IMAGES_ENABLED;
const { FEATURE_FLAG_DEFINITIONS } =
  await import("../../src/shared/constants/featureFlagDefinitions.ts");

const _model = "grok-imagine-image-2.0";

test("GROK_SUBSCRIPTION_IMAGES_ENABLED defaults to false and does not flip PII defaults", () => {
  const flag = FEATURE_FLAG_DEFINITIONS.find(
    (entry) => entry.key === "GROK_SUBSCRIPTION_IMAGES_ENABLED"
  );
  assert.ok(flag);
  assert.equal(flag.defaultValue, "false");
  assert.equal(flag.type, "boolean");
  for (const key of ["PII_REDACTION_ENABLED", "PII_RESPONSE_SANITIZATION"]) {
    assert.equal(
      FEATURE_FLAG_DEFINITIONS.find((entry) => entry.key === key)?.defaultValue,
      "false"
    );
  }
});
