/**
 * Unit tests for the "Crush" CLI tool catalog entry (ported from upstream
 * decolua/9router#1233). Mirrors the assertions used for the "pi" tool in
 * tests/unit/cli-tools-schema.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// ── Catalog shape ────────────────────────────────────────────────────────────

test("CLI_TOOLS contains a 'crush' entry modeled on 'pi'", async () => {
  const { CLI_TOOLS } = await import("../../src/shared/constants/cliTools.ts");
  const crush = CLI_TOOLS["crush"];
  assert.ok(crush, "crush entry must exist in CLI_TOOLS");
  assert.equal(crush.id, "crush");
  assert.equal(crush.name, "Crush");
  assert.equal(crush.configType, "custom");
  assert.equal(crush.category, "code");
  assert.equal(crush.acpSpawnable, false);
  assert.equal(crush.baseUrlSupport, "full");
  assert.equal(crush.defaultCommand, "crush");
  assert.equal(typeof crush.description, "string");
  assert.ok(crush.description.length > 0);
  assert.equal(typeof crush.docsUrl, "string");
  assert.ok(crush.docsUrl.length > 0);
});

test("getCliTool('crush') resolves the catalog entry", async () => {
  const { getCliTool } = await import("../../src/shared/constants/cliTools.ts");
  const crush = getCliTool("crush");
  assert.ok(crush);
  assert.equal(crush.id, "crush");
});

// ── Runtime config path ─────────────────────────────────────────────────────

test("getCliConfigPaths('crush') resolves to ~/.config/crush/crush.json", async () => {
  const { getCliConfigPaths } = await import("../../src/shared/services/cliRuntime.ts");
  const paths = getCliConfigPaths("crush");
  assert.ok(paths);
  assert.ok(
    paths.config?.endsWith(path.join(".config", "crush", "crush.json")),
    `Expected config path to end with .config/crush/crush.json, got: ${paths.config}`
  );
});
