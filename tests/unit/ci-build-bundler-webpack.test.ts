/**
 * Which bundler CI uses when it compiles the app (16/10/2026).
 *
 * A Turbopack production build of this tree needs ~36-49 GB (measured 2026-10-16 on the
 * 32-vCPU .113 with a cgroup cap and swap off: Next 16.3.5/16.3.6/16.3.8 peak at 33-37 GB
 * under the cap, 49 GB uncapped, and finish in 23-25 min; 16.4.2 needs more than 36 GB in
 * the compile phase alone and is OOM-killed). The .113 was raised from 48 to 64 GB on
 * 2026-10-16 and the build passed there with three lint jobs alongside; the 16 GB hosted
 * runners cannot hold it. The backend-only nightlies share the .113 with the light runners,
 * so they stay on webpack (14 GB) - with Turbopack they had not been green since 10-13.
 *
 * Policy: the fork runs only on GitHub-hosted runners, so the ci.yml Build always uses webpack.
 * Flip it only with a measurement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

type Step = { name?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function readWorkflow(name: string): Workflow {
  return load(fs.readFileSync(path.join(workflowDir, name), "utf8")) as Workflow;
}

/** Every step of `name` whose `run` matches `pattern`, tagged "file:job:step". */
function buildSteps(name: string, pattern: RegExp): Array<{ id: string; step: Step }> {
  const out: Array<{ id: string; step: Step }> = [];
  for (const [job, def] of Object.entries(readWorkflow(name).jobs ?? {})) {
    (def.steps ?? []).forEach((step, i) => {
      if (typeof step.run === "string" && pattern.test(step.run)) {
        out.push({ id: `${name}:${job}:${step.name ?? `#${i + 1}`}`, step });
      }
    });
  }
  return out;
}

test("the ci.yml Build job uses webpack on the hosted runner", () => {
  const [build] = buildSteps("ci.yml", /^pnpm run build$/m);
  assert.ok(build, "ci.yml build job runs `pnpm run build`");
  assert.equal(String(build.step.env?.OMNIROUTE_USE_TURBOPACK), "0");
});
