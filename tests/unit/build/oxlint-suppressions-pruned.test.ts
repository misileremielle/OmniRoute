// tests/unit/build/oxlint-suppressions-pruned.test.ts
// Invariants of oxlint-suppressions.json, the frozen lint debt (Oxlint bulk suppressions).
//
// `pnpm run lint` fails when the file carries a suppression for a violation that no longer
// occurs in a linted file ("There are suppressions that do not occur anymore"), so a stale or
// malformed entry is not cosmetic: it blocks commits (G-05, #15159).
//
// FILE SHAPE: keyed by FILE first, then rule, then count:
//
//   { "src/file.ts": { "no-unused-vars": { "count": 1 } } }
//
// Getting that backwards makes a "no bad entries" assertion pass vacuously — every lookup
// misses and the test reports green while the gate is red. `SHAPE-SANITY` below pins it.
//
// Whether an entry is actually stale needs a lint run: that is `pnpm run lint` itself (and
// tests/unit/run-oxlint-json-suppressions.test.ts covers the behaviour on a fixture). The
// tests here pin what can be checked from the file alone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// Oxlint reads the file from its working directory only; it has no location option.
const SUPPRESSIONS = join(ROOT, "oxlint-suppressions.json");

/** file → rule → { count } */
type SuppressionFile = Record<string, Record<string, Record<string, number>>>;

function readSuppressions(): SuppressionFile {
  return JSON.parse(readFileSync(SUPPRESSIONS, "utf8")) as SuppressionFile;
}

test("SHAPE-SANITY: the suppressions file is keyed by FILE first, then rule", () => {
  // Guards the whole suite against the inverted-lookup bug described in the
  // header. If Oxlint ever changes this format, this fails loudly instead of the
  // stale-entry assertions quietly passing on nothing.
  const parsed = readSuppressions();
  const firstFile = Object.keys(parsed)[0];
  const rules = Object.keys(parsed[firstFile] ?? {});

  assert.ok(
    firstFile.includes("/") || firstFile.includes("\\"),
    `expected a path, got ${firstFile}`
  );
  // Oxlint core rules have no plugin prefix (`no-unused-vars`), so a "/" is not a usable
  // marker; a rule bucket is recognised by its numeric `count`.
  assert.ok(
    rules.length > 0 && rules.every((rule) => typeof parsed[firstFile][rule]?.count === "number"),
    `expected rule names with a count at the second level, got ${JSON.stringify(parsed[firstFile])}`
  );
});

test("G-05: the suppressions file exists and parses", () => {
  assert.ok(existsSync(SUPPRESSIONS), `expected suppressions at ${SUPPRESSIONS}`);
  assert.ok(Object.keys(readSuppressions()).length > 0, "the file must not be empty");
});

test("G-05: every suppressed file still exists", () => {
  // Oxlint does not report an entry for a file that is gone, so a deleted or renamed file
  // would leave its frozen counts behind forever.
  const missing = Object.keys(readSuppressions()).filter((file) => !existsSync(join(ROOT, file)));
  assert.deepEqual(
    missing,
    [],
    `suppressions for files that no longer exist: ${missing.join(", ")}`
  );
});

test("G-05: every count is a positive integer", () => {
  const bad: string[] = [];
  for (const [file, byRule] of Object.entries(readSuppressions())) {
    for (const [rule, entry] of Object.entries(byRule ?? {})) {
      if (!Number.isInteger(entry?.count) || entry.count <= 0) bad.push(`${file} → ${rule}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("G-05: the suppressions file carries no empty file or rule buckets", () => {
  // An empty bucket ({}) survives a hand-edit but freezes nothing; it only hides that the
  // file was edited by hand instead of regenerated.
  const parsed = readSuppressions();
  const empties: string[] = [];

  for (const [file, byRule] of Object.entries(parsed)) {
    if (!byRule || Object.keys(byRule).length === 0) {
      empties.push(`${file} (no rules)`);
      continue;
    }
    for (const [rule, counts] of Object.entries(byRule)) {
      if (!counts || Object.keys(counts).length === 0) {
        empties.push(`${file} → ${rule} (no counts)`);
      }
    }
  }

  assert.deepEqual(empties, [], `empty buckets are unused suppressions: ${empties.join(", ")}`);
});

test("G-05: every suppressed file path uses forward slashes", () => {
  // Oxlint matches suppression keys against POSIX-style relative paths. A
  // backslash key silently stops matching, which turns a suppressed warning back
  // into a hard failure — and from the gate's exit code it looks identical to
  // "unpruned". Cheap to assert, expensive to debug.
  const bad = Object.keys(readSuppressions()).filter((file) => file.includes("\\"));
  assert.deepEqual(bad, [], `suppression keys must be POSIX-relative: ${bad.join(", ")}`);
});
