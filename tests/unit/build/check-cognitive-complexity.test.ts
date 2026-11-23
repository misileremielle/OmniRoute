// tests/unit/build/check-cognitive-complexity.test.ts
// Unit tests for the report-counting helper in check-cognitive-complexity.mjs.
// These tests validate countCognitiveViolations() against synthetic Oxlint
// JSON output — no filesystem access, no Oxlint subprocess.
import test from "node:test";
import assert from "node:assert/strict";
import { countCognitiveViolations } from "../../../scripts/check/check-cognitive-complexity.mjs";

// Minimal Oxlint JSON diagnostic shape used in fixtures. `code` is `<plugin>(<rule>)`.
type Diagnostic = { code: string; severity: "error"; message: string; filename: string };
type Report = { number_of_files: number; diagnostics: Diagnostic[] };

// The cognitive threshold is reported by oxlint-plugin-complexity's single rule.
const COGNITIVE = "complexity(complexity)";
// Oxlint core's cyclomatic rule shares the rule NAME but not the plugin.
const CYCLOMATIC = "eslint(complexity)";
const MAX_LINES = "eslint(max-lines-per-function)";

/** One entry per linted file: [filename, codes of its findings]. */
function makeReport(files: Array<[string, string[]]>): Report {
  return {
    number_of_files: files.length,
    diagnostics: files.flatMap(([filename, codes]) =>
      codes.map((code) => ({ code, severity: "error" as const, message: "violation", filename }))
    ),
  };
}

test("countCognitiveViolations: empty report returns 0", () => {
  assert.equal(countCognitiveViolations(makeReport([])), 0);
});

test("countCognitiveViolations: no cognitive-complexity findings returns 0", () => {
  const report = makeReport([["src/foo.ts", [CYCLOMATIC, MAX_LINES]]]);
  assert.equal(countCognitiveViolations(report), 0);
});

test("countCognitiveViolations: single cognitive-complexity violation in one file", () => {
  const report = makeReport([["src/foo.ts", [COGNITIVE]]]);
  assert.equal(countCognitiveViolations(report), 1);
});

test("countCognitiveViolations: multiple cognitive-complexity violations across files", () => {
  const report = makeReport([
    ["src/foo.ts", [COGNITIVE, COGNITIVE]],
    ["open-sse/bar.ts", [COGNITIVE]],
  ]);
  assert.equal(countCognitiveViolations(report), 3);
});

test("countCognitiveViolations: ignores other rules of the same plugin", () => {
  const report = makeReport([
    ["src/baz.ts", ["complexity(other-rule)", COGNITIVE, "complexity(another-rule)"]],
  ]);
  assert.equal(countCognitiveViolations(report), 1);
});

test("countCognitiveViolations: file with no findings contributes 0", () => {
  const report = makeReport([
    ["src/clean.ts", []],
    ["src/complex.ts", [COGNITIVE]],
  ]);
  assert.equal(countCognitiveViolations(report), 1);
});

test("countCognitiveViolations: the core cyclomatic rule of the same name is not counted", () => {
  const report = makeReport([["src/mixed.ts", [CYCLOMATIC, COGNITIVE, MAX_LINES, COGNITIVE]]]);
  assert.equal(countCognitiveViolations(report), 2);
});
