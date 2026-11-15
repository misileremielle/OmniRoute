import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_PACKAGE_FILES_TEST_NEGATIONS,
  findLeakedTestArtifactPaths,
  findMissingPackageFilesTestNegations,
  isCoveredByFiles,
} from "../../scripts/build/packArtifactTestLeaks.ts";

test("findLeakedTestArtifactPaths flags co-located test and __tests__ paths", () => {
  assert.deepEqual(
    findLeakedTestArtifactPaths([
      "open-sse/handlers/chatCore.ts",
      "open-sse/handlers/__tests__/chatCore.test.ts",
      "src/lib/combos/steps.ts",
      "src/lib/combos/steps.test.ts",
      "src/lib/foo.spec.tsx",
      "src/lib/foo.test.mjs",
    ]),
    [
      "open-sse/handlers/__tests__/chatCore.test.ts",
      "src/lib/combos/steps.test.ts",
      "src/lib/foo.spec.tsx",
      "src/lib/foo.test.mjs",
    ]
  );
});

test("findLeakedTestArtifactPaths returns empty when no tests ship", () => {
  assert.deepEqual(
    findLeakedTestArtifactPaths(["open-sse/handlers/chatCore.ts", "src/lib/combos/steps.ts"]),
    []
  );
});

test("isCoveredByFiles honours directory and exact package.json files entries", () => {
  assert.equal(isCoveredByFiles("src/lib/combos/steps.ts", ["src/lib/"]), true);
  assert.equal(isCoveredByFiles("src/lib/combos/steps.ts", ["src/lib/combos/steps.ts"]), true);
  assert.equal(isCoveredByFiles("src/domain/foo.ts", ["src/lib/"]), false);
  // Negations must not count as positive coverage.
  assert.equal(isCoveredByFiles("src/lib/combos/steps.ts", ["!**/*.test.ts"]), false);
});

test("findMissingPackageFilesTestNegations flags deleted negations", () => {
  assert.deepEqual(
    findMissingPackageFilesTestNegations([...REQUIRED_PACKAGE_FILES_TEST_NEGATIONS]),
    []
  );
  assert.deepEqual(
    findMissingPackageFilesTestNegations(["bin/", "open-sse/", "!**/*.test.ts"]),
    REQUIRED_PACKAGE_FILES_TEST_NEGATIONS.filter((e) => e !== "!**/*.test.ts")
  );
});
