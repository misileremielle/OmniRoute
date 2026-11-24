import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const workflow = readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");

// The fork validates each per-arch image by digest in the build job, before any public tag
// exists; the merge job only points tags at those digests.
test("each built image is smoke-tested and scanned before its digest is exported", () => {
  const smoke = workflow.indexOf("- name: Smoke-test the built images");
  const trivy = workflow.indexOf("- name: Trivy CRITICAL gate (blocking)");
  const trivyWeb = workflow.indexOf("- name: Trivy CRITICAL gate, web image (blocking)");
  const exportDigests = workflow.indexOf("- name: Export digests");
  const manifests = workflow.indexOf("- name: Create GHCR version manifests");
  assert.ok(smoke >= 0, "smoke-test step must exist");
  assert.ok(trivy > smoke && trivyWeb > trivy, "both Trivy gates follow the smoke test");
  assert.ok(exportDigests > trivyWeb, "digests are exported only after both gates");
  assert.ok(manifests > exportDigests, "tags are created only from exported digests");
});

test("smoke test runs both flavors by digest and checks the container health status", () => {
  const smoke = workflow.match(
    /- name: Smoke-test the built images[\s\S]*?(?=\n      - name:|\n      - uses:|\n\s*$)/
  );
  assert.ok(smoke, "smoke-test step must exist");
  assert.match(smoke[0], /for digest in "\$DIGEST_BASE" "\$DIGEST_WEB"; do/);
  assert.match(smoke[0], /\$\{GHCR_IMAGE_NAME\}@\$\{digest\}/);
  assert.match(smoke[0], /docker run/);
  assert.match(smoke[0], /docker inspect/);
  assert.match(smoke[0], /healthy/);
});

test("version manifests are validated per flavor before tagging", () => {
  const manifests = workflow.match(
    /- name: Create GHCR version manifests[\s\S]*?(?=\n      - name: Inspect image)/
  );
  assert.ok(manifests, "version manifest step must exist");
  assert.match(manifests[0], /docker-image-complete\.mjs/);
  assert.match(manifests[0], /create_manifest "\$\{GHCR_IMAGE_NAME\}" "" /);
  assert.match(manifests[0], /create_manifest "\$\{GHCR_IMAGE_NAME\}" "-web" /);
  assert.doesNotMatch(workflow, /Promote GHCR latest tags/);
});
