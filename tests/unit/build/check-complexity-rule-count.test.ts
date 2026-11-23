/**
 * Locks that complexity vs cognitive counts stay isolated when sharing one Oxlint report.
 * Existence reason: merging tree walks must NOT change either ratchet baseline semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  countCognitiveViolations,
  countComplexityViolations,
} from "../../../scripts/check/complexityLintReport.mjs";

test("countComplexityViolations ignores cognitive-complexity findings", () => {
  const report = {
    number_of_files: 1,
    diagnostics: [
      { code: "eslint(complexity)", filename: "src/a.ts" },
      { code: "eslint(max-lines-per-function)", filename: "src/a.ts" },
      { code: "complexity(complexity)", filename: "src/a.ts" },
      { code: "complexity(complexity)", filename: "src/a.ts" },
      // A finding of another rule, and the code-less stale-suppressions summary, count for neither.
      { code: "eslint(no-unused-vars)", filename: "src/a.ts" },
      { message: "There are suppressions that do not occur anymore.", filename: "" },
    ],
  };
  assert.equal(countComplexityViolations(report), 2);
  assert.equal(countCognitiveViolations(report), 2);
});

test("empty report → 0 for both counters", () => {
  const empty = { number_of_files: 0, diagnostics: [] };
  assert.equal(countComplexityViolations(empty), 0);
  assert.equal(countCognitiveViolations(empty), 0);
});
