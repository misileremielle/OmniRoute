/**
 * oxlint-version-pinned.test.ts — keep lint policy deterministic.
 *
 * A new Oxlint or lint-plugin release can change diagnostics, so resolving a newer version from
 * unchanged source can produce unrelated lint failures. The
 * bulk-suppressions feature the baseline relies on is also still undocumented upstream and may
 * change. Keep the direct declarations exact and aligned with the lockfile; an upgrade is a
 * deliberate change that regenerates oxlint-suppressions.json.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { importerDependency, readPnpmLock } from "../../scripts/ci/pnpmLock.mjs";

const ROOT = new URL("../../", import.meta.url);
const PINNED = ["oxlint", "oxlint-plugin-eslint"];
const REMOVED = [
  "eslint",
  "@eslint/compat",
  "eslint-config-next",
  "eslint-plugin-react-hooks",
  "eslint-plugin-sonarjs",
  "typescript-eslint",
];

async function readJson(relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fileURLToPath(new URL(relative, ROOT)), "utf8"));
}

test("oxlint and its plugins are directly pinned to the locked versions", async () => {
  const pkg = await readJson("package.json");
  const devDependencies = (pkg.devDependencies ?? {}) as Record<string, string>;
  const lock = readPnpmLock();

  for (const name of PINNED) {
    const declared = devDependencies[name];
    const locked = importerDependency(lock, name)?.version;
    assert.ok(declared, `${name} must be a direct devDependency`);
    assert.match(declared, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
    assert.ok(locked, `${name} missing from pnpm-lock.yaml`);
    assert.equal(
      declared,
      locked,
      `package.json declares ${name}@${declared} but pnpm-lock.yaml resolves ${locked}`
    );
  }
});

test("the fork lints with Oxlint only: no ESLint package is declared", async () => {
  const pkg = await readJson("package.json");
  const declared = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  };
  assert.deepEqual(
    REMOVED.filter((name) => name in declared),
    []
  );
});
