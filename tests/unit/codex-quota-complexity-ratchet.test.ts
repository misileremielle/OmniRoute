import test from "node:test";
import assert from "node:assert/strict";
import { runComplexityLintOn } from "../../scripts/check/complexityLintReport.mjs";

// The complexity ratchet (oxlint.complexity.json: cyclomatic complexity>15,
// max-lines-per-function>80, cognitive complexity>15) compares per touched file against the
// base. The Codex freshness work once pushed src/domain/quotaCache.ts over its base count and
// failed Fast Quality Gates on PR #18742. New logic must live in helpers so this file stays
// at the base count.
const BASE_VIOLATIONS = 9;

test("quotaCache.ts stays within its base complexity violation count", () => {
  const report = runComplexityLintOn(["src/domain/quotaCache.ts"]);
  assert.equal(report.number_of_files, 1, "the file must actually be linted");
  const violations = report.diagnostics.length;
  assert.ok(
    violations <= BASE_VIOLATIONS,
    `quotaCache.ts has ${violations} complexity violations, base allows ${BASE_VIOLATIONS}`
  );
});
