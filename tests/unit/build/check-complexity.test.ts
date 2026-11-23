// tests/unit/build/check-complexity.test.ts
// The complexity ratchet must scan the SAME first-party scope documented in
// oxlint.complexity.json `files` and in complexity-baseline.json (src + open-sse + bin).
// Task 6A.11 re-baselined the count claiming bin coverage while the scan only passed
// src+open-sse — a fake-green gap (a god-function added under bin/ would pass the gate unseen).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LINT_ARGS } from "../../../scripts/check/check-complexity.mjs";
import {
  COGNITIVE_RULES,
  COMPLEXITY_CONFIG,
  COMPLEXITY_RULES,
  runComplexityLintOn,
} from "../../../scripts/check/complexityLintReport.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("check-complexity scans the full documented scope (src, open-sse, bin)", () => {
  assert.ok(
    LINT_ARGS.includes("bin"),
    "LINT_ARGS must include 'bin' — a new god-function under bin/ must not pass the gate green"
  );
  assert.ok(LINT_ARGS.includes("src"), "LINT_ARGS must include 'src'");
  assert.ok(LINT_ARGS.includes("open-sse"), "LINT_ARGS must include 'open-sse'");
  assert.ok(LINT_ARGS.includes(COMPLEXITY_CONFIG), "the walk must use the standalone config");
});

test("the complexity config enables exactly the rules the ratchets count", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, COMPLEXITY_CONFIG), "utf8"));
  const enabled = new Set<string>();
  for (const override of config.overrides)
    for (const rule of Object.keys(override.rules)) enabled.add(rule);
  assert.deepEqual([...enabled].sort(), [...COMPLEXITY_RULES, ...COGNITIVE_RULES].sort());
  const cyclomaticScope = config.overrides.find((o: { rules: object }) => "complexity" in o.rules);
  assert.ok(cyclomaticScope.files.some((glob: string) => glob.startsWith("bin/")));
});

// Oxlint has no `noInlineConfig` (the ESLint complexity config had it). A disable comment that
// names one of the counted rules, or names no rule at all, would hide a function from the
// ratchet, so the scanned tree must not contain one.
test("no disable comment in the scanned tree can hide a function from the ratchet", () => {
  const counted = [...COMPLEXITY_RULES, ...COGNITIVE_RULES];
  const directive = /(?:eslint|oxlint)-disable(?:-next-line|-line)?([^\n]*)/g;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        if (!source.includes("-disable")) continue;
        for (const match of source.matchAll(directive)) {
          const rules = match[1]
            .split("--")[0]
            .replace(/\*\/.*$/, "")
            .trim();
          const names = rules.split(",").map((name) => name.trim());
          if (rules === "" || names.some((name) => counted.includes(name))) {
            offenders.push(`${path.relative(ROOT, full)}: ${match[0].trim().slice(0, 80)}`);
          }
        }
      }
    }
  };
  for (const dir of ["src", "open-sse", "bin"]) walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, []);
});

// #14744: CI can run from a symlinked checkout. The base-worktree path of runComplexityLintOn
// copies the HEAD config into the other tree; comparing path strings instead of real paths
// would take the symlinked root for another tree and copy the config onto itself.
test("runComplexityLintOn leaves the config intact under a symlinked repo root", () => {
  const configPath = path.join(ROOT, COMPLEXITY_CONFIG);
  const before = fs.readFileSync(configPath, "utf8");
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-cplx-")), "root");
  fs.symlinkSync(ROOT, link, "dir");
  try {
    const report = runComplexityLintOn(["src/shared/utils/circuitBreaker.ts"], link);
    assert.equal(report.number_of_files, 1);
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
    assert.deepEqual(
      fs.readdirSync(ROOT).filter((name) => name.startsWith(".oxlint.complexity.head-")),
      []
    );
  } finally {
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  }
});
