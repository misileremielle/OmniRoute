import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
);

// The fork measures coverage on main as a report only: it never fails the gate.
test("shards and the coverage report merge incrementally and stay out of the gate", () => {
  const runs: string[] = Object.values(workflow.jobs).flatMap(
    (job: { steps?: { run?: string }[] }) =>
      (job.steps || [])
        .map((step) => step.run || "")
        .filter((run) => /pnpm exec c8(?: report)?\s/.test(run))
  );
  assert.equal(runs.length, 2);
  for (const run of runs) assert.match(run, /--merge-async\b/);
  assert.ok(runs.some((run) => run.includes("pnpm run test:unit:ci:shard")));
  const aggregate = runs.find((run) => run.includes("pnpm exec c8 report"));
  assert.doesNotMatch(aggregate, /--check-coverage\b/);
  assert.equal(workflow.jobs.coverage["continue-on-error"], true);
  assert.equal(workflow.jobs["coverage-shard"]["continue-on-error"], true);
  for (const job of ["coverage", "coverage-shard"]) {
    assert.ok(!workflow.jobs.gate.needs.includes(job), `${job} is not part of the gate`);
  }
});
