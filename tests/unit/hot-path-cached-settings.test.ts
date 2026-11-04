import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// These modules run on every chat / embeddings request (guardrail pre/post hooks and
// the detailed-log gate). Calling the raw getSettings() there meant 4-6 full
// SELECT + JSON.parse + decrypt passes over the settings namespace per request.
// They must use the 5s TTL getCachedSettings() (invalidated by updateSettings()).
const HOT_PATH_MODULES = [
  "src/lib/guardrails/visionBridge.ts",
  "src/lib/guardrails/credentialMasker.ts",
  "src/lib/db/detailedLogs.ts",
];

for (const relPath of HOT_PATH_MODULES) {
  test(`${relPath} reads settings through the TTL cache`, () => {
    const source = readFileSync(
      fileURLToPath(new URL(`../../${relPath}`, import.meta.url)),
      "utf8"
    );
    assert.ok(
      !/import\s*\{[^}]*\bgetSettings\b[^}]*\}\s*from\s*["'](?:@\/lib\/db|\.)\/settings["']/.test(
        source
      ),
      `${relPath} must not import the uncached getSettings()`
    );
    assert.ok(source.includes("getCachedSettings"), `${relPath} must use getCachedSettings()`);
  });
}
