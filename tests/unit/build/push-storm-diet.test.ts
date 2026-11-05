// Push-storm diet (2026-10-18): every push to a release branch used to start the full ci.yml
// matrix only for the next push to cancel it. ci.yml runs on push only for `main`; PRs into
// main and release/** and merge groups still get the full matrix. (The quality.yml and
// Release-Green halves of this guard were removed with those workflows.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

interface Workflow {
  on?: {
    push?: { branches?: string[] };
    pull_request?: { branches?: string[] };
    merge_group?: unknown;
  };
  concurrency?: { "cancel-in-progress"?: unknown };
  jobs?: Record<string, { if?: string }>;
}

const WORKFLOWS_DIR = path.join(process.cwd(), ".github", "workflows");
const load = (file: string): Workflow =>
  yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8")) as Workflow;

for (const file of ["ci.yml"]) {
  test(`${file}: push trigger is main-only; PRs and merge groups still cover release/**`, () => {
    const on = load(file).on ?? {};
    assert.deepEqual(
      on.push?.branches,
      ["main"],
      `${file} must not run the matrix per release push`
    );
    assert.deepEqual(on.pull_request?.branches, ["main", "release/**"]);
    assert.ok(on.merge_group, `${file} keeps the merge-queue trigger`);
  });
}
