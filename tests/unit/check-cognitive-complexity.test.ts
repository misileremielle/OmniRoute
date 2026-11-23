import { test } from "node:test";
import assert from "node:assert";
import {
  countCognitiveViolations,
  evaluateCognitiveComplexity,
} from "../../scripts/check/check-cognitive-complexity.mjs";

// The .mjs module has no .d.ts; type the exported functions locally.
type LintReport = { number_of_files: number; diagnostics: Array<{ code: string }> };
type CogComplexityVerdict = { regressed: boolean; improved: boolean };

const count = countCognitiveViolations as (report: LintReport) => number;
const evaluate = evaluateCognitiveComplexity as (
  current: number,
  baseline: number
) => CogComplexityVerdict;

const report = (...codes: string[]): LintReport => ({
  number_of_files: 2,
  diagnostics: codes.map((code) => ({ code })),
});

// --- countCognitiveViolations tests ---

test("countCognitiveViolations: empty report returns 0", () => {
  assert.equal(count(report()), 0);
});

test("countCognitiveViolations: counts oxlint-plugin-complexity findings", () => {
  assert.equal(
    count(
      report(
        "complexity(complexity)",
        "eslint(no-unused-vars)", // should not count
        "complexity(complexity)",
        "complexity(complexity)"
      )
    ),
    3
  );
});

test("countCognitiveViolations: no matching rules returns 0", () => {
  // `eslint(complexity)` is Oxlint core's cyclomatic rule, counted by the other ratchet.
  assert.equal(count(report("eslint(no-eval)", "eslint(no-console)", "eslint(complexity)")), 0);
});

// --- evaluateCognitiveComplexity tests ---

const FROZEN = 738;

test("evaluateCognitiveComplexity: equal to baseline passes", () => {
  const r = evaluate(FROZEN, FROZEN);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, false);
});

test("evaluateCognitiveComplexity: one more violation is a regression", () => {
  const r = evaluate(FROZEN + 1, FROZEN);
  assert.equal(r.regressed, true);
  assert.equal(r.improved, false);
});

test("evaluateCognitiveComplexity: fewer violations is an improvement", () => {
  const r = evaluate(FROZEN - 1, FROZEN);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, true);
});

test("evaluateCognitiveComplexity: zero violations is maximum improvement", () => {
  const r = evaluate(0, FROZEN);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, true);
});

test("evaluateCognitiveComplexity: strict integer comparison", () => {
  assert.equal(evaluate(11, 10).regressed, true);
  assert.equal(evaluate(10, 10).regressed, false);
  assert.equal(evaluate(9, 10).regressed, false);
});
