/**
 * docker-publish checks out shallow. On 2026-11-03 the full clone (`fetch-depth: 0`, a 2.6 GB
 * pack) ran 30+ min in `prepare` on a Blacksmith runner, outside GitHub's network. The image
 * build never reads history (.dockerignore drops .git).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const workflow = load(
  fs.readFileSync(path.join(repoRoot, ".github/workflows/docker-publish.yml"), "utf8")
) as { jobs: Record<string, { steps?: Step[] }> };

test("no docker-publish checkout clones the full history", () => {
  const deep: string[] = [];
  for (const [job, def] of Object.entries(workflow.jobs)) {
    for (const step of def.steps ?? []) {
      if (!step.uses?.startsWith("actions/checkout@")) continue;
      if (Number(step.with?.["fetch-depth"] ?? 1) !== 1) deep.push(job);
    }
  }
  assert.deepEqual(deep, []);
});
