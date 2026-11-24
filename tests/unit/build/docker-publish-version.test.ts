// tests/unit/build/docker-publish-version.test.ts
// Which Docker tag each docker-publish event writes. main is the only writer of :latest;
// a release publishes its version; the fork has no :next channel (#8576 upstream).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const RESOLVE_VERSION = path.join(ROOT, "scripts/ci/resolve-docker-publish-version.sh");
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/docker-publish.yml"), "utf8");

function resolveVersion(eventName: string, refType: string, refName: string): string {
  return execFileSync("bash", [RESOLVE_VERSION, eventName, refType, refName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("main publishes latest; a release publishes its version", () => {
  assert.equal(resolveVersion("push", "branch", "main"), "latest");
  // A manual run publishes the selected ref exactly like a push of it.
  assert.equal(resolveVersion("workflow_dispatch", "branch", "main"), "latest");
  assert.equal(resolveVersion("workflow_dispatch", "tag", "v3.8.50"), "3.8.50");
  assert.equal(resolveVersion("release", "tag", "v3.8.50"), "3.8.50");
});

test("release and other branches fail closed", () => {
  for (const branch of ["release/v3.8.55", "feature/not-a-publish-source"]) {
    assert.throws(
      () => resolveVersion("workflow_dispatch", "branch", branch),
      /Unsupported Docker publish branch/
    );
  }
});

test("unsafe versions are refused", () => {
  assert.throws(() => resolveVersion("release", "tag", "v1.2.3;rm"), /unsafe VERSION/);
});

test("the workflow publishes on main and releases only, and never a :next channel", () => {
  assert.doesNotMatch(WORKFLOW, /release\/v\*/);
  assert.doesNotMatch(WORKFLOW, /"next"/);
  assert.match(WORKFLOW, /push:\n    branches: \[main\]/);
  assert.match(WORKFLOW, /release:\n    types: \[released\]/);
});

test("only main may resolve to latest, and other versions must be plain semver", () => {
  assert.match(WORKFLOW, /\[ "\$REF_NAME" != "main" \]/);
  assert.match(WORKFLOW, /Only main publishes :latest/);
  assert.match(WORKFLOW, /grep -qE -- '-web\$'/);
  assert.match(WORKFLOW, /\[ "\$REF_NAME" != "v\$VERSION" \]/);
});

test("every image keeps the blocking vulnerability gate", () => {
  const gate = WORKFLOW.match(/- name: Trivy CRITICAL gate \(blocking\)[\s\S]*?exit-code: "1"/);
  assert.ok(gate, "blocking Trivy gate must remain present");
  assert.doesNotMatch(gate[0], /\n\s+if:/);
});
