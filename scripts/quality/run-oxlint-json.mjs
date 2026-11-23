#!/usr/bin/env node
/**
 * Single Oxlint pass that always writes a JSON report for quality:collect.
 *
 * Existence reason: one inventory of net-new issues (vs oxlint-suppressions.json) should feed
 * both the blocking lint gate and the eslintWarnings ratchet — not two full-tree walks.
 *
 * Exit code: 1 when the report has errors, else 0. Warnings do not fail by default (same as
 * `pnpm run lint`); pass `--max-warnings=<n>`, `--max-warnings <n>` or `--deny-warnings` to
 * fail on them. The verdict is computed here from the report, so any other argument is
 * rejected (exit 2) rather than forwarded to Oxlint and ignored. A stale suppression — a frozen
 * violation that was fixed — does not fail this gate: it is release-time housekeeping
 * (`oxlint --prune-suppressions`). `pnpm run lint` and the commit hook stay strict about it.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  lintMeasurementCounts,
  ruleIdOf,
  runOxlintJson,
  withoutSuppressionSummaries,
} from "./oxlint-report.mjs";

/** Warning limit from the CLI: null (no limit) or a non-negative integer. Exits 2 on bad input. */
function parseMaxWarnings(argv) {
  const usage = (message) => {
    console.error(
      `[lint:json] ${message}\n  usage: run-oxlint-json.mjs [--max-warnings=<n> | --max-warnings <n> | --deny-warnings]`
    );
    process.exit(2);
  };
  let limit = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value;
    if (arg === "--deny-warnings") value = "0";
    else if (arg === "--max-warnings") value = argv[++i];
    else if (arg.startsWith("--max-warnings=")) value = arg.slice("--max-warnings=".length);
    else usage(`unsupported argument: ${arg}`);
    if (!/^\d+$/.test(value ?? "")) usage(`--max-warnings needs a non-negative integer`);
    limit = limit === null ? Number(value) : Math.min(limit, Number(value));
  }
  return limit;
}

const outFile = path.resolve(
  ROOT,
  process.env.LINT_RESULTS_JSON || path.join(".artifacts", "oxlint-results.json")
);
fs.mkdirSync(path.dirname(outFile), { recursive: true });

const maxWarnings = parseMaxWarnings(process.argv.slice(2));

let run;
try {
  run = runOxlintJson(["."], { cwd: ROOT });
} catch (err) {
  // Killed (OOM) or crashed before printing a report: say so, and leave no stale report behind.
  fs.rmSync(outFile, { force: true });
  console.error(`[lint:json] ${err && err.message}`);
  process.exit(1);
}

const { report, stale } = withoutSuppressionSummaries(run.report);
fs.writeFileSync(outFile, `${JSON.stringify(report)}\n`);

let counts;
try {
  counts = lintMeasurementCounts(report);
} catch (err) {
  console.error(`[lint:json] ${err.message} (report: ${path.relative(ROOT, outFile)})`);
  process.exit(1);
}

if (stale) {
  console.log(
    "[lint:json] stale entries in oxlint-suppressions.json (not blocking here); run `pnpm exec oxlint --prune-suppressions .`"
  );
}

const warningsOver = maxWarnings !== null && counts.warnings > maxWarnings;
const failed = counts.errors > 0 || warningsOver;
const print = failed ? console.error : console.log;
print(
  `[lint:json] ${report.number_of_files} files: ${counts.errors} error(s), ${counts.warnings} warning(s)`
);
if (failed) {
  // With a JSON report on disk a red run would otherwise print nothing about WHAT failed.
  const shown = report.diagnostics.filter(
    (d) => d.severity === "error" || (warningsOver && d.severity === "warning")
  );
  for (const d of shown.slice(0, 60)) {
    const line = d.labels?.[0]?.span?.line ?? 0;
    console.error(
      `  ✗ ${d.filename || "(no file)"}:${line} ${d.severity} ${ruleIdOf(d) ?? "(core)"} — ${String(d.message).split("\n")[0].slice(0, 120)}`
    );
  }
  if (shown.length > 60) {
    console.error(
      `  … and ${shown.length - 60} more (full report: ${path.relative(ROOT, outFile)})`
    );
  }
}

process.exit(failed ? 1 : 0);
