/**
 * eslint-react-hooks-version-pinned.test.ts — keep lint policy deterministic.
 *
 * eslint-config-next accepts any eslint-plugin-react-hooks 7.x release. Minor
 * releases can change React Compiler diagnostics, so resolving a newer plugin
 * from unchanged source can produce hundreds of unrelated lint failures. Keep
 * the direct declaration exact and aligned with the lockfile.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { importerDependency, readPnpmLock } from "../../scripts/ci/pnpmLock.mjs";

const ROOT = new URL("../../", import.meta.url);
const PLUGIN = "eslint-plugin-react-hooks";
const EXPECTED_VERSION = "7.1.1";

async function readJson(relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fileURLToPath(new URL(relative, ROOT)), "utf8"));
}

test("eslint-plugin-react-hooks is directly pinned to the locked version", async () => {
  const pkg = await readJson("package.json");
  const declared = ((pkg.devDependencies ?? {}) as Record<string, string>)[PLUGIN];
  const locked = importerDependency(readPnpmLock(), PLUGIN)?.version;

  assert.ok(declared, `${PLUGIN} must be a direct devDependency`);
  assert.equal(
    declared,
    EXPECTED_VERSION,
    `${PLUGIN} must remain pinned to ${EXPECTED_VERSION} so a group bump can never ride past the compiler-rules migration review`
  );
  assert.ok(locked, `${PLUGIN} missing from pnpm-lock.yaml`);
  assert.equal(
    declared,
    locked,
    `package.json declares ${PLUGIN}@${declared} but pnpm-lock.yaml resolves ${locked}`
  );
});
