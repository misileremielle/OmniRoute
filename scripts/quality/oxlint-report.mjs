/**
 * Shared Oxlint runner and report helpers for the lint gates.
 *
 * `pnpm run lint` and lint-staged call `oxlint` directly and stay strict. The gates that
 * measure (lint:json, quality:collect, release-green, the complexity ratchets) go through
 * this module, which reads the JSON report and computes its own verdict.
 *
 * Stale suppressions: when a frozen violation is fixed and `oxlint-suppressions.json` still
 * counts it, Oxlint adds one summary diagnostic and exits non-zero. That is release-time
 * housekeeping (`oxlint --prune-suppressions`), not a defect, so the measuring gates drop that
 * one diagnostic. ESLint had `--pass-on-unpruned-suppressions` for this; Oxlint 1.94 has no
 * such flag (oxc-project/oxc#20991). A second config run in the same directory (the complexity
 * ratchets) reports every entry as stale for the same reason (oxc-project/oxc#28386).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** File name Oxlint reads from the working directory; it has no location option. */
export const SUPPRESSIONS_FILE = "oxlint-suppressions.json";

export const STALE_SUPPRESSIONS_MESSAGE = "There are suppressions that do not occur anymore.";
export const UNCOVERED_VIOLATIONS_MESSAGE =
  "There are new violations not covered by the suppressions file.";

export function oxlintBin(root = ROOT) {
  return path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "oxlint.cmd" : "oxlint"
  );
}

/** Parse the `-f json` report out of stdout; null when there is no complete report. */
export function parseOxlintJson(out) {
  const text = String(out || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  // The report is one object; stderr text may be glued after it when a caller merges streams.
  for (const end of [text.length, text.lastIndexOf("}") + 1]) {
    try {
      const report = JSON.parse(text.slice(start, end));
      return report && Array.isArray(report.diagnostics) ? report : null;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Oxlint appends up to two summaries about the suppressions file to the findings. They carry
 * no rule code and no file name:
 *   - stale: a frozen violation was fixed and the file still counts it;
 *   - uncovered: there are violations the file does not cover — the findings themselves are
 *     in the report too, so this one only repeats them.
 * Neither is a finding, so neither may be counted as one.
 */
export function isSuppressionSummary(diagnostic) {
  return (
    !!diagnostic &&
    !diagnostic.code &&
    !diagnostic.filename &&
    [STALE_SUPPRESSIONS_MESSAGE, UNCOVERED_VIOLATIONS_MESSAGE].includes(diagnostic.message)
  );
}

/** The report without the suppression summaries, plus which of them were present. */
export function withoutSuppressionSummaries(report) {
  const summaries = report.diagnostics.filter(isSuppressionSummary).map((d) => d.message);
  return {
    report: { ...report, diagnostics: report.diagnostics.filter((d) => !isSuppressionSummary(d)) },
    stale: summaries.includes(STALE_SUPPRESSIONS_MESSAGE),
    uncovered: summaries.includes(UNCOVERED_VIOLATIONS_MESSAGE),
  };
}

/** `eslint(no-eval)` -> `no-eval`, `typescript-eslint(no-explicit-any)` -> `typescript/no-explicit-any`. */
export function ruleIdOf(diagnostic) {
  const match = /^([^()]+)\((.+)\)$/.exec(String(diagnostic?.code || ""));
  if (!match) return null;
  const plugin = match[1] === "typescript-eslint" ? "typescript" : match[1];
  return plugin === "eslint" ? match[2] : `${plugin}/${match[2]}`;
}

/** A full-tree measurement must have linted files and carry a known severity on every finding. */
export function lintMeasurementCounts(report) {
  if (
    !report ||
    !Array.isArray(report.diagnostics) ||
    !Number.isSafeInteger(report.number_of_files) ||
    report.number_of_files <= 0 ||
    report.diagnostics.some((d) => !d || !["error", "warning"].includes(d.severity))
  ) {
    throw new Error("Oxlint measurement is incomplete or invalid");
  }
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of report.diagnostics) {
    if (isSuppressionSummary(diagnostic)) continue;
    if (diagnostic.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}

/** Per-file count of findings whose rule id is in `rules`; paths are relative to the lint cwd. */
export function perFileRuleCounts(report, rules) {
  const counts = new Map();
  for (const diagnostic of report?.diagnostics || []) {
    if (!diagnostic.filename || !rules.has(ruleIdOf(diagnostic))) continue;
    const file = diagnostic.filename.split(path.sep).join("/");
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return counts;
}

export function countRuleViolations(report, rules) {
  let count = 0;
  for (const diagnostic of report?.diagnostics || []) {
    if (rules.has(ruleIdOf(diagnostic))) count++;
  }
  return count;
}

/**
 * Run Oxlint with `-f json` and return the parsed report. Throws when the process was killed
 * or printed no report: a tool failure is never "zero findings".
 */
export function runOxlintJson(args, { cwd = ROOT, bin = oxlintBin() } = {}) {
  const result = spawnSync(bin, ["-f", "json", ...args], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = parseOxlintJson(result.stdout);
  if (result.status === null || !report) {
    const reason =
      result.status === null ? `killed by ${result.signal || "a signal"}` : "no JSON report";
    throw new Error(
      `oxlint ${args.join(" ")}: ${reason}${result.stderr ? `\n${result.stderr.slice(0, 2000)}` : ""}`
    );
  }
  return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
}
