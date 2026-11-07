// tests/unit/build/docker-source-ref-dispatch.test.ts
// A workflow_dispatch publish checked out refs/tags/v<version> unconditionally, so a fork that
// does not mirror upstream tags failed at checkout ("couldn't find remote ref refs/tags/v3.8.54").
// The build source ref is now resolved in `prepare`: the tag when present, else the dispatched
// commit — but only when its package.json carries the requested version.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../../scripts/ci/resolve-docker-source-ref.sh");
const SHA = "7ef045f0ba2ab28db28ce82183f6f4013815aece";

function run(args: string[], opts: { remoteTags?: string[]; pkgVersion?: string }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docker-source-ref-"));
  try {
    const bin = path.join(dir, "bin");
    const lines = (opts.remoteTags ?? []).map((t) => `${"0".repeat(40)}\t${t}`);
    // Fake `git ls-remote --tags --refs origin <ref>`: print the listed tag equal to <ref>.
    writeFileSync(path.join(dir, "tags.txt"), lines.join("\n") + (lines.length ? "\n" : ""));
    mkdirSync(bin);
    const fakeGit = [
      "#!/bin/sh",
      'for last in "$@"; do :; done',
      `awk -F'\\t' -v r="$last" '$2 == r' "${path.join(dir, "tags.txt")}"`,
      "",
    ].join("\n");
    writeFileSync(path.join(bin, "git"), fakeGit);
    chmodSync(path.join(bin, "git"), 0o755);
    const pkg = path.join(dir, "package.json");
    if (opts.pkgVersion !== undefined) {
      writeFileSync(pkg, JSON.stringify({ name: "omniroute", version: opts.pkgVersion }));
    }
    const result = spawnSync("bash", [SCRIPT, ...args, pkg], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("non-dispatch events keep the triggering ref (empty output)", () => {
  const r = run(["push", "next", SHA], { pkgVersion: "3.8.54" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("dispatch builds the version tag when origin has it", () => {
  const r = run(["workflow_dispatch", "3.8.54", SHA], {
    remoteTags: ["refs/tags/v3.8.54"],
    pkgVersion: "3.9.0",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "refs/tags/v3.8.54");
});

test("dispatch without the tag falls back to the dispatched commit when package.json matches", () => {
  const r = run(["workflow_dispatch", "3.8.54", SHA], {
    remoteTags: ["refs/tags/radar-export-latest"],
    pkgVersion: "3.8.54",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, SHA);
  assert.match(r.stderr, /::warning::Tag v3\.8\.54 not found/);
});

test("dispatch without the tag fails when package.json is a different version", () => {
  const r = run(["workflow_dispatch", "3.8.4", SHA], { pkgVersion: "3.8.54" });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /::error::Tag v3\.8\.4 not found/);
});

test("a tag that only prefixes the requested one does not count", () => {
  const r = run(["workflow_dispatch", "3.8.5", SHA], {
    remoteTags: ["refs/tags/v3.8.54"],
    pkgVersion: "3.8.54",
  });
  assert.notEqual(r.status, 0);
});
