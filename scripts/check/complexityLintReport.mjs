#!/usr/bin/env node
/**
 * Shared Oxlint runner for the complexity + cognitive-complexity ratchets.
 * One tree walk with oxlint.complexity.json -> JSON report; consumers count by rule id.
 *
 * The config is standalone: it enables only the three rules below, so its counts are isolated
 * from the main lint. The walk runs in the repo root, where Oxlint also reads the main lint's
 * oxlint-suppressions.json; none of its entries name these rules, so nothing is hidden, and the
 * "stale suppressions" summary it produces is dropped (see scripts/quality/oxlint-report.mjs).
 *
 * Oxlint has no `noInlineConfig`: an `eslint-disable`/`oxlint-disable` comment naming one of
 * these rules, or naming no rule at all, would hide a function from the ratchet.
 * tests/unit/build/check-complexity.test.ts fails when src/, open-sse/ or bin/ contain one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countRuleViolations,
  parseOxlintJson,
  runOxlintJson,
  withoutSuppressionSummaries,
} from "../quality/oxlint-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const COMPLEXITY_CONFIG = "oxlint.complexity.json";

/** Positional dirs — must match the config's `files` scopes (see check-complexity tests). */
export const LINT_SCAN_DIRS = ["src", "open-sse", "bin"];

/** Args after the oxlint binary (tests lock the scan dirs on this array). */
export const LINT_ARGS = ["-c", COMPLEXITY_CONFIG, "--disable-nested-config", ...LINT_SCAN_DIRS];

/** Oxlint core: cyclomatic complexity and function length. */
export const COMPLEXITY_RULES = new Set(["complexity", "max-lines-per-function"]);

/** oxlint-plugin-complexity, cognitive threshold only (its cyclomatic threshold is unreachable). */
export const COGNITIVE_RULES = new Set(["complexity/complexity"]);

export function countComplexityViolations(report) {
  return countRuleViolations(report, COMPLEXITY_RULES);
}

export function countCognitiveViolations(report) {
  return countRuleViolations(report, COGNITIVE_RULES);
}

/**
 * Run Oxlint once (or reuse COMPLEXITY_LINT_REPORT / the in-process cache).
 * @returns {{diagnostics: Array<object>, number_of_files: number}}
 */
export function getComplexityLintReport() {
  const fromEnv = process.env.COMPLEXITY_LINT_REPORT;
  if (fromEnv && fs.existsSync(fromEnv)) {
    const report = parseOxlintJson(fs.readFileSync(fromEnv, "utf8"));
    if (!report) throw new Error(`COMPLEXITY_LINT_REPORT is not an Oxlint JSON report: ${fromEnv}`);
    return report;
  }
  if (getComplexityLintReport._cache) return getComplexityLintReport._cache;

  const { report } = withoutSuppressionSummaries(runOxlintJson(LINT_ARGS, { cwd: ROOT }).report);
  if (!Number.isSafeInteger(report.number_of_files) || report.number_of_files <= 0) {
    throw new Error("complexity walk linted no files");
  }
  getComplexityLintReport._cache = report;

  const outDir = path.join(ROOT, ".artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "complexity-lint.json"), JSON.stringify(report));
  } catch {
    // best-effort cache for sibling steps / local inspection
  }
  return report;
}

getComplexityLintReport._cache = null;

/**
 * New-code mode: lint ONLY `files` (relative to `cwd`) with the same config, in `cwd` (ROOT for
 * HEAD, a throwaway base worktree for the merge-base). Returns an empty report for no files.
 * Both trees are measured by the HEAD config. Oxlint resolves `files` globs from the config's
 * own directory (a config outside `cwd` matches nothing), so a base worktree gets a temporary
 * copy of it.
 * @param {string[]} files
 * @param {string} cwd
 */
export function runComplexityLintOn(files, cwd = ROOT) {
  const existing = files.filter((f) => fs.existsSync(path.join(cwd, f)));
  if (existing.length === 0) return { diagnostics: [], number_of_files: 0 };
  // Compare real paths: under a symlinked cwd the two strings differ for the same directory,
  // and copying a file onto itself would truncate it. In another tree the HEAD config goes in
  // under a private name (never over a file that exists) and is removed afterwards.
  const sameTree = fs.realpathSync(cwd) === fs.realpathSync(ROOT);
  const config = sameTree ? COMPLEXITY_CONFIG : `.oxlint.complexity.head-${process.pid}.json`;
  const configPath = path.join(cwd, config);
  if (!sameTree) {
    fs.copyFileSync(path.join(ROOT, COMPLEXITY_CONFIG), configPath, fs.constants.COPYFILE_EXCL);
  }
  try {
    const args = [
      "-c",
      config,
      "--disable-nested-config",
      "--no-error-on-unmatched-pattern",
      ...existing,
    ];
    return withoutSuppressionSummaries(runOxlintJson(args, { cwd }).report).report;
  } finally {
    if (!sameTree) fs.rmSync(configPath, { force: true });
  }
}
