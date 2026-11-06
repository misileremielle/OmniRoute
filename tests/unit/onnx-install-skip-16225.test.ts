/**
 * #16225 — onnxruntime-node's postinstall downloads ~300MB of CUDA binaries on linux/x64,
 * though the package already bundles the CPU ones. A checkout install must never run it.
 *
 * Under pnpm the guarantee is `allowBuilds: { onnxruntime-node: false }` in
 * pnpm-workspace.yaml: the script is skipped entirely, whatever the environment says. The
 * install action also sets ONNXRUNTIME_NODE_INSTALL=skip, so a cache-miss install stays
 * safe even if the deny entry is ever lost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const root = join(import.meta.dirname, "..", "..");
type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { steps?: Step[] };
const read = <T>(file: string) => load(readFileSync(join(root, file), "utf8")) as T;

test("pnpm never runs the onnxruntime-node install script", () => {
  assert.equal(
    read<{ allowBuilds: Record<string, boolean> }>("pnpm-workspace.yaml").allowBuilds[
      "onnxruntime-node"
    ],
    false
  );
});

test("the install action's cache-miss step also carries the skip flag", () => {
  const action = read<{ runs: { steps: Step[] } }>(".github/actions/pnpm-install-retry/action.yml");
  const install = action.runs.steps.find((step) => step.name === "pnpm install (with retry)");
  assert.ok(install, "the installation step must exist");
  assert.match(install.run ?? "", /pnpm install --frozen-lockfile/);
  assert.equal(install.env?.ONNXRUNTIME_NODE_INSTALL, "skip");
});

test("no workflow installs dependencies outside the audited action", () => {
  for (const name of ["ci", "build"]) {
    const workflow = read<{ jobs: Record<string, Job> }>(`.github/workflows/${name}.yml`);
    for (const [job, def] of Object.entries(workflow.jobs)) {
      for (const step of def.steps ?? []) {
        assert.doesNotMatch(
          String(step.run ?? ""),
          /\b(npm ci|pnpm install)\b/,
          `${name}.yml/${job}: install through .github/actions/pnpm-install-retry`
        );
      }
    }
  }
});
