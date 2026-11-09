import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18nConfig from "../../config/i18n.json" with { type: "json" };

/**
 * Parity guard: every locale declared in config/i18n.json (the single source of
 * truth) must ship both UI catalogs — the dashboard catalog and the CLI catalog.
 * The documentation is English-only, so no locale carries a docs mirror: the
 * translated tree under docs/i18n/ and the README links into it must stay gone.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const { code } of i18nConfig.locales) {
  test(`locale ${code} ships both UI catalogs`, () => {
    assert.ok(
      existsSync(path.join(ROOT, "src", "i18n", "messages", `${code}.json`)),
      "dashboard catalog"
    );
    assert.ok(existsSync(path.join(ROOT, "bin", "cli", "locales", `${code}.json`)), "CLI catalog");
  });
}

test("the documentation is English-only (no docs/i18n mirror tree)", () => {
  assert.equal(existsSync(path.join(ROOT, "docs", "i18n")), false, "docs/i18n/ must not exist");
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /docs\/i18n\//, "README.md must not link translated docs");
});
