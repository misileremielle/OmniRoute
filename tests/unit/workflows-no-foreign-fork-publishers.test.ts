/**
 * Policy guard: no workflow in this repository may publish to — or be gated on — a
 * DIFFERENT repository's namespace.
 *
 * Twice now a contributor's own fork CI has ridden into the canonical repo as an
 * unrelated extra file in an otherwise on-topic PR:
 *
 *   .github/workflows/build-fork.yml           added by #1528 (scope: SSE translator)
 *     env: IMAGE_NAME: ghcr.io/kang-heewon/omniroute
 *     if:  github.repository == 'kang-heewon/OmniRoute'
 *     → the guard sits on the JOB, not the workflow, so GitHub instantiated a run on
 *       every push to main and every v* tag and skipped the job: 100+ runs, zero
 *       runner cost, and a permanently noisy check board on every release.
 *
 *   .github/workflows/build-rinseaid-image.yml added by #8729 (scope: SSE reasoning)
 *     tags: ghcr.io/rinseaid/omniroute:...
 *     → no repository guard at all; it simply never fires because its trigger branch
 *       (`build-k3-reasoning-image`) does not exist here. 0 runs.
 *
 * Neither can succeed: this repo's GITHUB_TOKEN cannot write to another owner's GHCR
 * namespace. So the cost is not a breach, it is dead configuration that review keeps
 * waving through because the PR it arrives in is about something else entirely.
 *
 * This test is the cheap check that review is not: it reads the workflow directory and
 * fails on any foreign owner, so the next accidental inclusion is caught by CI instead
 * of surviving until someone wonders why a release board shows a skipped fork job.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

/**
 * The GitHub owner of this repository: every `github.repository` guard and every GHCR namespace
 * must name it. The fork (misileremielle/omniroute) publishes only to its own GHCR namespace and
 * has no Docker Hub repository (docs/ops/FORK_IDENTITY.md).
 */
const OWNER = "misileremielle";
const REGISTRY_OWNERS: Record<string, string[]> = {
  "ghcr.io": [OWNER],
  "docker.io": [],
  "index.docker.io": [],
};

/**
 * Every key and scalar of a parsed workflow, joined by newlines. Parsing drops YAML comments
 * the way GitHub does, so prose in a comment never counts and a quoted value containing `#`
 * is kept whole. Shell comments inside a `run:` block are part of the script and still count.
 */
function workflowStrings(text: string): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        out.push(key);
        walk(value);
      }
    } else if (node !== null && node !== undefined) out.push(String(node));
  };
  walk(load(text));
  return out.join("\n");
}

function foreignRegistryTargets(text: string): string[] {
  const found: string[] = [];
  // ghcr.io/<owner>/... and index.docker.io/<owner>/... — the owner is the segment
  // right after the registry host.
  for (const m of workflowStrings(text).matchAll(
    /\b(ghcr\.io|(?:index\.)?docker\.io)\/([A-Za-z0-9_.-]+)/g
  )) {
    const [, host, owner] = m;
    if (!REGISTRY_OWNERS[host].includes(owner.toLowerCase())) found.push(m[0]);
  }
  return found;
}

test("registry targets in YAML comments are ignored, real ones are not", () => {
  const yaml = [
    "# Mirrors ghcr.io/someone-else/omniroute for reference",
    "env:",
    "  IMAGE: ghcr.io/other/omniroute # also see ghcr.io/third/x",
    "  OURS: ghcr.io/misileremielle/omniroute",
    "",
  ].join("\n");
  assert.deepEqual(foreignRegistryTargets(yaml), ["ghcr.io/other"]);
});

test("a quoted value containing ' #' does not hide a later target on the same line", () => {
  const yaml = 'env: { NOTE: "tag #1", IMAGE: ghcr.io/other/omniroute }\n';
  assert.deepEqual(foreignRegistryTargets(yaml), ["ghcr.io/other"]);
});

function workflowFiles(): string[] {
  return fs
    .readdirSync(workflowDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(workflowDir, f));
}

test("no workflow publishes to another owner's container registry", () => {
  const offenders: string[] = [];

  for (const file of workflowFiles()) {
    for (const target of foreignRegistryTargets(fs.readFileSync(file, "utf-8"))) {
      offenders.push(`${path.basename(file)} → ${target}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `workflow(s) target a registry namespace that is not ours (${JSON.stringify(REGISTRY_OWNERS)}):\n  ${offenders.join("\n  ")}\n` +
      `A fork's publish workflow does not belong in the canonical repository — it cannot ` +
      `authenticate anyway, and it pollutes every release check board.`
  );
});

test("no workflow job is gated on a different repository", () => {
  const offenders: string[] = [];

  for (const file of workflowFiles()) {
    const text = workflowStrings(fs.readFileSync(file, "utf-8"));
    // `if: github.repository == 'owner/name'` — a guard naming someone else's repo means
    // the workflow was written for a fork.
    for (const m of text.matchAll(/github\.repository\s*[=!]=\s*['"]([^'"]+)['"]/g)) {
      const [owner] = m[1].split("/");
      if (owner.toLowerCase() !== OWNER) {
        offenders.push(`${path.basename(file)} → ${m[0]}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `workflow(s) gate on a foreign repository:\n  ${offenders.join("\n  ")}\n` +
      `Note the failure mode: a job-level guard still instantiates a run on every ` +
      `matching trigger, so the workflow shows up as a skipped check forever.`
  );
});
