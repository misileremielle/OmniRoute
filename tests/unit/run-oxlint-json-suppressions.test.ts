// A stale suppression — a frozen violation that was fixed while oxlint-suppressions.json still
// counts it — is release-time housekeeping, not a defect (#11600, #7837). ESLint had
// `--pass-on-unpruned-suppressions` for the measuring gates; Oxlint 1.94 has no such flag
// (oxc-project/oxc#20991) and exits non-zero. So `pnpm run lint` and the commit hook are strict,
// and the measuring gates (lint:json, quality:collect, release-green, the complexity ratchets)
// read the JSON report through scripts/quality/oxlint-report.mjs and drop the summary.
//
// These tests run the real Oxlint binary on a two-file fixture (not the repo tree), so they
// also fail loudly if a new Oxlint release changes this still-undocumented behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STALE_SUPPRESSIONS_MESSAGE,
  SUPPRESSIONS_FILE,
  UNCOVERED_VIOLATIONS_MESSAGE,
  lintMeasurementCounts,
  oxlintBin,
  parseOxlintJson,
  ruleIdOf,
  runOxlintJson,
  withoutSuppressionSummaries,
} from "../../scripts/quality/oxlint-report.mjs";

const VIOLATION = "const unused = 1;\nmodule.exports = {};\n";
const CLEAN = "module.exports = {};\n";

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-suppression-repro-"));
  fs.writeFileSync(
    path.join(dir, ".oxlintrc.json"),
    JSON.stringify({ categories: { correctness: "off" }, rules: { "no-unused-vars": "error" } })
  );
  fs.writeFileSync(path.join(dir, "a.js"), VIOLATION);
  fs.writeFileSync(path.join(dir, "b.js"), CLEAN);
  return dir;
}

function freeze(dir: string) {
  const result = spawnSync(oxlintBin(), ["--suppress-all", "."], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `baseline freeze should succeed: ${result.stderr}`);
  const frozen = JSON.parse(fs.readFileSync(path.join(dir, SUPPRESSIONS_FILE), "utf8"));
  assert.deepEqual(frozen, { "a.js": { "no-unused-vars": { count: 1 } } });
}

test("a stale suppression makes plain oxlint fail but is not a finding for the measuring gates", () => {
  const dir = makeFixture();
  try {
    freeze(dir);
    // Frozen debt is not reported.
    const frozenRun = runOxlintJson(["."], { cwd: dir });
    assert.equal(frozenRun.status, 0);
    assert.deepEqual(lintMeasurementCounts(frozenRun.report), { errors: 0, warnings: 0 });

    // Someone fixes the violation without pruning: 0 real errors, one orphaned entry.
    fs.writeFileSync(path.join(dir, "a.js"), CLEAN);

    // Strict path (`pnpm run lint`, lint-staged): the commit must prune.
    const strict = spawnSync(oxlintBin(), ["."], { cwd: dir, encoding: "utf8" });
    assert.notEqual(strict.status, 0, "plain oxlint is expected to fail on a stale suppression");

    // Measuring path: the summary is recognised, dropped, and never counted.
    const run = runOxlintJson(["."], { cwd: dir });
    assert.notEqual(run.status, 0);
    assert.ok(run.report.diagnostics.some((d) => d.message === STALE_SUPPRESSIONS_MESSAGE));
    const { report, stale, uncovered } = withoutSuppressionSummaries(run.report);
    assert.equal(stale, true);
    assert.equal(uncovered, false);
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(lintMeasurementCounts(run.report), { errors: 0, warnings: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a new violation beyond the frozen count is counted once, without its summary", () => {
  const dir = makeFixture();
  try {
    freeze(dir);
    fs.writeFileSync(path.join(dir, "b.js"), VIOLATION);

    const run = runOxlintJson(["."], { cwd: dir });
    assert.notEqual(run.status, 0);
    const { report, stale, uncovered } = withoutSuppressionSummaries(run.report);
    assert.equal(stale, false);
    assert.equal(uncovered, true);
    assert.ok(run.report.diagnostics.some((d) => d.message === UNCOVERED_VIOLATIONS_MESSAGE));
    assert.deepEqual(
      report.diagnostics.map((d) => [d.filename, ruleIdOf(d)]),
      [["b.js", "no-unused-vars"]]
    );
    // The "uncovered" summary has error severity; counting it would report 2 errors.
    assert.deepEqual(lintMeasurementCounts(run.report), { errors: 1, warnings: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a report that linted nothing, or is not a report, is not a measurement", () => {
  assert.throws(() => lintMeasurementCounts({ number_of_files: 0, diagnostics: [] }));
  assert.throws(() => lintMeasurementCounts(null));
  assert.throws(() =>
    lintMeasurementCounts({ number_of_files: 1, diagnostics: [{ code: "eslint(x)" }] })
  );
  assert.equal(parseOxlintJson("no json here"), null);
  assert.equal(parseOxlintJson('{"other":1}'), null);
});

test("parseOxlintJson tolerates text around the report; ruleIdOf maps plugin codes", () => {
  const body = JSON.stringify({ number_of_files: 1, diagnostics: [] });
  assert.deepEqual(parseOxlintJson(`banner\n${body}\ntrailing stderr text`), JSON.parse(body));
  assert.equal(ruleIdOf({ code: "eslint(no-eval)" }), "no-eval");
  assert.equal(ruleIdOf({ code: "typescript(no-explicit-any)" }), "typescript/no-explicit-any");
  assert.equal(
    ruleIdOf({ code: "eslint-js(no-restricted-syntax)" }),
    "eslint-js/no-restricted-syntax"
  );
  assert.equal(ruleIdOf({ message: STALE_SUPPRESSIONS_MESSAGE }), null);
});

test("lint:json rejects arguments it cannot honour instead of ignoring them", () => {
  const script = path.resolve(import.meta.dirname, "../../scripts/quality/run-oxlint-json.mjs");
  for (const args of [["--fix"], ["--max-warnings=abc"], ["--max-warnings"], ["src"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")} must exit 2, got ${result.status}`);
  }
});
