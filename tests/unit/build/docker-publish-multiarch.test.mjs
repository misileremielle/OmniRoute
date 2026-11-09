// Runs the real shell scripts of .github/workflows/docker-publish.yml against a fake `docker`
// (and a fake `git` for the prepare step). Policy under test: the Node and Web images publish to
// GHCR only, each from exactly two validated digests (one linux/amd64, one linux/arm64).
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");
const buildJob = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  merge:"));

const AMD64 = "a".repeat(64);
const ARM64 = "b".repeat(64);
const AMD64_AGAIN = "c".repeat(64);
const ALL_FLAVORS = ["base", "web"];
const GHCR = "ghcr.io/example/image";

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function script(name) {
  const block = step(name).split("        run: |\n")[1];
  assert.ok(block, `missing shell script: ${name}`);
  const lines = [];
  for (const line of block.split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    lines.push(line.replace(/^ {10}/, ""));
  }
  return lines.join("\n");
}

// A shell script, not node: the scripts under test call it dozens of times per file.
// Inspect answers: refs ending in ARM64 are arm64 digests, other digests amd64, and tags come from
// FAKE_TAGS ("ref=state" words, "complete" unless listed). FAKE_FAIL_INSPECT and FAKE_FAIL_CREATE
// hold substrings of refs whose inspect or create call fails.
const FAKE_DOCKER = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
  'index() { printf "{\\"manifests\\":[";',
  '  sep=""; for arch in "$@"; do',
  '    printf "%s{\\"platform\\":{\\"os\\":\\"linux\\",\\"architecture\\":\\"%s\\"}}" "$sep" "$arch"; sep=",";',
  '  done; printf "]}\\n"; }',
  'if [ "$3" = create ]; then',
  '  for part in $FAKE_FAIL_CREATE; do case "$5" in *"$part"*) echo "push failed" >&2; exit 1;; esac; done',
  "  exit 0",
  "fi",
  'for ref in "$@"; do :; done',
  'for part in $FAKE_FAIL_INSPECT; do case "$ref" in *"$part"*)',
  '  echo "ERROR: failed to do request: 429 Too Many Requests" >&2; exit 1;; esac; done',
  'case "$ref" in',
  `  *@sha256:${ARM64}) index arm64; exit 0;;`,
  "  *@sha256:*) index amd64; exit 0;;",
  "esac",
  "state=complete",
  'for entry in $FAKE_TAGS; do case "$entry" in "$ref="*) state="${entry##*=}";; esac; done',
  'case "$state" in',
  '  missing) echo "ERROR: docker.io/$ref: not found" >&2; exit 1;;',
  "  amd64-only) index amd64;;",
  "  *) index amd64 arm64;;",
  "esac",
  "",
].join("\n");

function withSandbox(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docker-publish-test-"));
  try {
    writeFileSync(path.join(dir, "docker"), FAKE_DOCKER);
    writeFileSync(path.join(dir, "git"), `#!/bin/sh\n[ "$1" = tag ] && echo v1.0.0\nexit 0\n`);
    chmodSync(path.join(dir, "docker"), 0o755);
    chmodSync(path.join(dir, "git"), 0o755);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeDigests(dir, digests) {
  for (const [flavor, names] of Object.entries(digests)) {
    if (names === null) continue;
    mkdirSync(path.join(dir, "digests", flavor), { recursive: true });
    for (const name of names) writeFileSync(path.join(dir, "digests", flavor, name), "");
  }
}

function runScript(dir, name, { scenario = {}, env = {} } = {}) {
  const logFile = path.join(dir, "docker.log");
  const outputFile = path.join(dir, "github-output");
  rmSync(logFile, { force: true });
  rmSync(outputFile, { force: true });
  writeFileSync(logFile, "");
  writeFileSync(outputFile, "");
  const result = spawnSync(
    "bash",
    ["-c", script(name).replaceAll("/tmp/digests", path.join(dir, "digests"))],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GHCR_IMAGE_NAME: GHCR,
        VERSION: "1.0.0",
        GITHUB_OUTPUT: outputFile,
        FAKE_DOCKER_LOG: logFile,
        FAKE_TAGS: Object.entries(scenario.tags ?? {})
          .map(([ref, state]) => `${ref}=${state}`)
          .join(" "),
        FAKE_FAIL_INSPECT: (scenario.failInspect ?? []).join(" "),
        FAKE_FAIL_CREATE: (scenario.failCreate ?? []).join(" "),
        DOCKER_IMAGE_COMPLETE_RETRY_DELAY_MS: "0",
        ...env,
      },
      encoding: "utf8",
    }
  );
  const calls = readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("="))
  );
  return {
    ...result,
    combined: result.stdout + result.stderr,
    outputs,
    inspected: calls.filter((call) => call[2] === "inspect").map((call) => call.at(-1)),
    created: calls
      .filter((call) => call[2] === "create")
      .map((call) => call[call.indexOf("-t") + 1]),
  };
}

function runGuard(digests, scenario) {
  return withSandbox((dir) => {
    const pairs = Object.fromEntries(ALL_FLAVORS.map((flavor) => [flavor, [AMD64, ARM64]]));
    writeDigests(dir, { ...pairs, ...digests });
    return runScript(dir, "Guard against stale digests", { scenario });
  });
}

const DIGEST_SETS = [
  ["0", []],
  ["1", [AMD64]],
  ["3", [AMD64, ARM64, AMD64_AGAIN]],
];

for (const flavor of ALL_FLAVORS) {
  for (const [label, names] of DIGEST_SETS) {
    test(`guard: ${label} ${flavor} digests stop the publish`, () => {
      const result = runGuard({ [flavor]: names });
      assert.notEqual(result.status, 0, result.combined);
    });
  }

  test(`guard: a missing ${flavor} digest directory stops the publish`, () => {
    const result = runGuard({ [flavor]: null });
    assert.notEqual(result.status, 0, result.combined);
  });

  test(`guard: two AMD64 ${flavor} digests stop the publish`, () => {
    const result = runGuard({ [flavor]: [AMD64, AMD64_AGAIN] });
    assert.notEqual(result.status, 0, result.combined);
  });
}

test("guard: a registry failure stops the publish", () => {
  const result = runGuard({}, { failInspect: [GHCR] });
  assert.notEqual(result.status, 0, result.combined);
});

test("guard: a complete set passes and validates only GHCR digests", () => {
  const result = runGuard({});
  assert.equal(result.status, 0, result.combined);
  assert.doesNotMatch(result.combined, /::warning::/);
  assert.ok(result.inspected.length > 0);
  assert.ok(
    result.inspected.every((ref) => ref.startsWith(`${GHCR}@`)),
    result.inspected.join()
  );
});

test("build: the Node and Web digests are exported and uploaded, and nothing can skip them", () => {
  for (const name of [
    "Build and push platform image by digest",
    "Build and push WEB platform image by digest",
    "Export digests",
    "Upload base digests",
    "Upload web digests",
  ]) {
    assert.doesNotMatch(step(name), /continue-on-error/, name);
  }
  for (const name of ["Upload base digests", "Upload web digests"]) {
    assert.match(step(name), /if-no-files-found: error/, name);
  }
  assert.match(workflow, /platform: linux\/amd64/);
  assert.match(workflow, /platform: linux\/arm64/);
});

test("build: the Node and Web export writes one digest per flavor", () => {
  withSandbox((dir) => {
    const result = runScript(dir, "Export digests", {
      env: { DIGEST_BASE: `sha256:${AMD64}`, DIGEST_WEB: `sha256:${ARM64}` },
    });
    assert.equal(result.status, 0, result.combined);
    assert.deepEqual(readdirSync(path.join(dir, "digests")).sort(), ["base", "web"]);
    assert.ok(existsSync(path.join(dir, "digests/base", AMD64)));
    assert.ok(existsSync(path.join(dir, "digests/web", ARM64)));
  });
});

test("the workflow publishes neither Bun images nor Docker Hub tags", () => {
  assert.doesNotMatch(workflow, /Dockerfile\.bun|-bun\b|bun-base|bun-web/);
  assert.doesNotMatch(workflow, /DOCKERHUB|docker\.io|dockerhub-description|Login to Docker Hub/);
});

function runManifests(env, scenario) {
  return withSandbox((dir) => {
    writeDigests(dir, Object.fromEntries(ALL_FLAVORS.map((flavor) => [flavor, [AMD64, ARM64]])));
    return runScript(dir, "Create GHCR version manifests", { env, scenario });
  });
}

const tag = (suffix) => `${GHCR}:1.0.0${suffix}`;

test("Create GHCR version manifests: creates the Node and Web tags", () => {
  const result = runManifests();
  assert.equal(result.status, 0, result.combined);
  assert.deepEqual(result.created, [tag(""), tag("-web")]);
});

test("Create GHCR version manifests: a failed manifest fails the step", () => {
  const result = runManifests({}, { failCreate: ["1.0.0-web"] });
  assert.notEqual(result.status, 0, result.combined);
  assert.deepEqual(result.created, [tag(""), tag("-web")]);
});

function runPromotion(scenario) {
  return withSandbox((dir) => runScript(dir, "Promote GHCR latest tags", { scenario }));
}

const latest = (suffix) => `${GHCR}:latest${suffix}`;

test("Promote GHCR latest tags: promotes both flavors", () => {
  const result = runPromotion();
  assert.equal(result.status, 0, result.combined);
  assert.deepEqual(result.created, [latest(""), latest("-web")]);
});

test("Promote GHCR latest tags: an incomplete source moves no alias at all", () => {
  const result = runPromotion({ tags: { [tag("-web")]: "amd64-only" } });
  assert.notEqual(result.status, 0, result.combined);
  assert.deepEqual(result.created, []);
});

const PREPARE = "Resolve version, latest-promotion, and skip flag";
const TAG_PUSH = {
  EVENT_NAME: "push",
  REF_TYPE: "tag",
  REF_NAME: "v1.0.0",
  DEFAULT_BRANCH: "main",
};
const MANDATORY_REFS = [`${GHCR}:1.0.0`, `${GHCR}:1.0.0-web`];

function runPrepare(env, scenario) {
  // Actions defines every variable of the step's env block, empty when the event lacks it.
  const stepEnv = { ...env };
  return withSandbox((dir) => runScript(dir, PREPARE, { env: stepEnv, scenario }));
}

test("prepare: skips when both GHCR images are complete", () => {
  const result = runPrepare(TAG_PUSH);
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.outputs.skip, "true");
  assert.deepEqual(result.inspected, MANDATORY_REFS);
});

for (const ref of MANDATORY_REFS) {
  test(`prepare: rebuilds when ${ref} is missing and stops looking at the first miss`, () => {
    const result = runPrepare(TAG_PUSH, { tags: { [ref]: "missing" } });
    assert.equal(result.status, 0, result.combined);
    assert.equal(result.outputs.skip, "false");
    assert.equal(result.inspected.at(-1), ref);
    assert.equal(new Set(result.inspected).size, MANDATORY_REFS.indexOf(ref) + 1);
  });
}

test("prepare: rebuilds when a mandatory tag has a single architecture", () => {
  const result = runPrepare(TAG_PUSH, { tags: { [`${GHCR}:1.0.0`]: "amd64-only" } });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.outputs.skip, "false");
});

test("prepare: a registry failure fails the job instead of forcing a rebuild", () => {
  const result = runPrepare(TAG_PUSH, { failInspect: [`${GHCR}:1.0.0`] });
  assert.notEqual(result.status, 0, result.combined);
  assert.match(result.combined, /::error::Could not inspect/);
  assert.equal(result.outputs.skip, undefined);
  assert.equal(
    result.inspected.filter((ref) => ref === `${GHCR}:1.0.0`).length,
    3,
    "the helper retries before giving up"
  );
});

test("prepare: a push to main publishes :latest without skipping or inspecting", () => {
  const result = runPrepare({
    EVENT_NAME: "push",
    REF_TYPE: "branch",
    REF_NAME: "main",
    DEFAULT_BRANCH: "main",
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.outputs.version, "latest");
  assert.equal(result.outputs.promote_latest, "false");
  assert.equal(result.outputs.skip, "false");
  assert.deepEqual(result.inspected, []);
});

test("prepare: floating channels never skip or inspect", () => {
  const result = runPrepare({
    EVENT_NAME: "push",
    REF_TYPE: "branch",
    REF_NAME: "release/v1.0.0",
    DEFAULT_BRANCH: "release/v1.0.0",
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.outputs.version, "next");
  assert.equal(result.outputs.skip, "false");
  assert.deepEqual(result.inspected, []);
});

test("manual dispatch takes no inputs: every job builds the selected ref", () => {
  assert.match(workflow, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /inputs\./);
  assert.doesNotMatch(buildJob, /\n\s+ref:/);
});

test("prepare: a manual run on main publishes :latest like a push", () => {
  const result = runPrepare({
    EVENT_NAME: "workflow_dispatch",
    REF_TYPE: "branch",
    REF_NAME: "main",
    DEFAULT_BRANCH: "main",
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(result.outputs.version, "latest");
  assert.equal(result.outputs.skip, "false");
});

test("the image builds read only the dependency cache and export none", () => {
  for (const name of [
    "Build and push platform image by digest",
    "Build and push WEB platform image by digest",
  ]) {
    assert.match(step(name), /cache-from: type=gha,scope=docker-deps-\$\{\{ matrix\.arch \}\}/, name);
    assert.doesNotMatch(step(name), /cache-to:/, name);
  }
  const deps = step("Cache the dependency layers");
  assert.match(deps, /target: deps/);
  assert.match(deps, /outputs: type=cacheonly/);
  assert.match(deps, /cache-to: type=gha,scope=docker-deps-\$\{\{ matrix\.arch \}\},mode=max,ignore-error=true/);
});
