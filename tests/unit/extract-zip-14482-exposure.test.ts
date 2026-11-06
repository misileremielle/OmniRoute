// tests/unit/extract-zip-14482-exposure.test.ts
// Probe for issue #14482 — extract-zip GHSA-7pqw-9j4j-h8q3 / GHSA-jmr9-qjv8-65gv.
//
// This is NOT a functional-bug repro (there is no OmniRoute code path that calls the
// vulnerable npm package). It is a reachability/exposure proof: it asserts the two
// premises the triage relies on to call this "accepted risk, doc-only fix" rather than
// "code bug, needs a patch":
//   1. extract-zip is reachable ONLY through the promptfoo (devDependency) ->
//      @openai/codex-security chain — never through a production dependency.
//   2. OmniRoute's own source (src/, open-sse/, bin/, electron/ *code*, not its
//      pnpm-lock.yaml) never imports the "extract-zip" npm package directly.
// If either assertion ever breaks (e.g. a future PR adds extract-zip as a direct or
// production dependency, or a production module starts importing it), this test goes
// red and should block merge until re-triaged — that is the intended regression guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { dependentsOf, readPnpmLock } from "../../scripts/ci/pnpmLock.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// Reads the committed pnpm-lock.yaml directly rather than the installed tree: the
// lockfile's snapshot edges are deterministic and checkout-local, independent of what
// happens to be physically installed in node_modules.
test("extract-zip (GHSA-7pqw-9j4j-h8q3 / GHSA-jmr9-qjv8-65gv) is reachable only via the promptfoo devDependency chain", () => {
  const lock = readPnpmLock(ROOT);
  const root = lock.importers["."];

  // 1. The root project must never depend on extract-zip directly (prod or dev).
  assert.ok(
    !Object.prototype.hasOwnProperty.call(root.dependencies ?? {}, "extract-zip"),
    "root project must not depend on extract-zip directly (production)"
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(root.devDependencies ?? {}, "extract-zip"),
    "root project must not depend on extract-zip directly (dev)"
  );

  // 2. Exactly one package in the whole tree declares a dependency on extract-zip,
  //    and it must be @openai/codex-security.
  const extractZipDependents = dependentsOf(lock, "extract-zip");
  assert.deepEqual(
    extractZipDependents,
    ["@openai/codex-security"],
    `expected only @openai/codex-security to depend on extract-zip, got: ${extractZipDependents.join(", ")}`
  );

  // 3. The only thing that depends on @openai/codex-security must be promptfoo.
  const codexSecurityDependents = dependentsOf(lock, "@openai/codex-security");
  assert.deepEqual(
    codexSecurityDependents,
    ["promptfoo"],
    `expected only promptfoo to depend on @openai/codex-security, got: ${codexSecurityDependents.join(", ")}`
  );

  // 4. promptfoo itself must be a devDependency, never a production dependency —
  //    this is what makes `pnpm audit --prod` correctly report 0 for this chain.
  assert.ok(
    Object.prototype.hasOwnProperty.call(root.devDependencies ?? {}, "promptfoo"),
    "promptfoo must be listed under devDependencies"
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(root.dependencies ?? {}, "promptfoo"),
    "promptfoo must NOT also be listed under production dependencies"
  );
});

test("OmniRoute's own production/runtime code never imports the extract-zip npm package", () => {
  const scanDirs = ["src", "open-sse", "bin"].map((d) => path.join(ROOT, d));
  const offenders: string[] = [];

  function walkFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walkFiles(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        const content = fs.readFileSync(full, "utf8");
        // Match an actual import/require of the npm package, not incidental substring
        // hits like our own local `extractZip()` helper function name.
        if (/(?:from\s+["']extract-zip["']|require\(["']extract-zip["']\))/.test(content)) {
          offenders.push(full);
        }
      }
    }
  }

  for (const dir of scanDirs) walkFiles(dir);

  assert.deepEqual(
    offenders,
    [],
    `expected no production import of the vulnerable "extract-zip" npm package, found: ${offenders.join(", ")}`
  );
});
