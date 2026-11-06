// tests/unit/build/check-lockfile.test.ts
// Tests for check-lockfile.mjs — lockfile policy gate (Task 7.7).
//
// The policy checks run against in-memory lock objects; the workspace consistency check
// runs the real pnpm command against a throwaway workspace.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  getLockfilePolicy,
  findLockfileViolations,
  getWorkspaceDependencyCheckCommand,
  runWorkspaceDependencyCheck,
} from "../../../scripts/check/check-lockfile.mjs";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { parsePnpmLock, readPnpmLock } from "../../../scripts/ci/pnpmLock.mjs";

const SHA = "sha512-" + "a".repeat(86) + "==";
const policy = { allowedHosts: ["registry.npmjs.org"] };
const lockWith = (resolution: Record<string, string>) => ({
  packages: { "left-pad@1.0.0": { resolution } },
});

test("getLockfilePolicy: points at pnpm-lock.yaml and only the npm registry", () => {
  const cfg = getLockfilePolicy();
  assert.ok(cfg.lockfilePath.endsWith("pnpm-lock.yaml"));
  assert.deepEqual(cfg.allowedHosts, ["registry.npmjs.org"]);
});

test("findLockfileViolations: a registry package with sha512 integrity passes", () => {
  assert.deepEqual(findLockfileViolations(lockWith({ integrity: SHA }), policy), []);
});

test("findLockfileViolations: missing or non-sha512 integrity is rejected", () => {
  assert.match(findLockfileViolations(lockWith({}), policy)[0], /sha512/);
  assert.match(findLockfileViolations(lockWith({ integrity: "sha1-abc" }), policy)[0], /sha512/);
});

test("findLockfileViolations: a plain-http tarball is rejected", () => {
  const found = findLockfileViolations(
    lockWith({
      integrity: SHA,
      tarball: "http://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
    }),
    policy
  );
  assert.ok(found.some((v: string) => /not HTTPS/.test(v)));
});

test("findLockfileViolations: a tarball from another host is rejected", () => {
  const found = findLockfileViolations(
    lockWith({ integrity: SHA, tarball: "https://evil.example/left-pad-1.0.0.tgz" }),
    policy
  );
  assert.ok(found.some((v: string) => /evil\.example is not allowed/.test(v)));
});

test("findLockfileViolations: an unparseable tarball URL is rejected", () => {
  const found = findLockfileViolations(lockWith({ integrity: SHA, tarball: "not a url" }), policy);
  assert.ok(found.some((v: string) => /invalid tarball URL/.test(v)));
});

test("the committed pnpm-lock.yaml satisfies the policy", () => {
  const lock = readPnpmLock();
  assert.ok(Object.keys(lock.packages).length > 1000, "the dependency document was parsed");
  assert.deepEqual(findLockfileViolations(lock, getLockfilePolicy()), []);
});

test("parsePnpmLock: skips the leading pnpm self-pin document", () => {
  const lock = parsePnpmLock(
    "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n---\n" +
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  a@1.0.0: {}\n"
  );
  assert.deepEqual(Object.keys(lock.packages), ["a@1.0.0"]);
});

test("getWorkspaceDependencyCheckCommand: frozen, lockfile-only, no scripts", () => {
  const command = getWorkspaceDependencyCheckCommand("linux");
  assert.equal(command.command, "pnpm");
  assert.deepEqual(command.args, [
    "install",
    "--frozen-lockfile",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
});

test("getWorkspaceDependencyCheckCommand: invokes pnpm.cmd through cmd.exe on Windows", () => {
  const command = getWorkspaceDependencyCheckCommand("win32", "C:\\Windows\\System32\\cmd.exe");
  assert.equal(command.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(command.args.slice(0, 4), ["/d", "/s", "/c", "pnpm.cmd"]);
});

test("runWorkspaceDependencyCheck: reports failures without masking diagnostics", () => {
  const failure = Object.assign(new Error("ERR_PNPM_OUTDATED_LOCKFILE"), {
    stdout: "",
    stderr: "ERR_PNPM_OUTDATED_LOCKFILE",
  });
  const result = runWorkspaceDependencyCheck({
    platform: "linux",
    execFile: () => {
      throw failure;
    },
  });
  assert.deepEqual(result, { ok: false, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE" });
});

test("workspace check fails on a manifest the lockfile does not satisfy", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omniroute-lockfile-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(path.join(root, "packages", "example"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  const example = path.join(root, "packages", "example", "package.json");
  writeFileSync(example, JSON.stringify({ name: "example", version: "1.0.0" }));
  writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n" +
      "importers:\n\n  .: {}\n\n  packages/example: {}\n"
  );
  const command = getWorkspaceDependencyCheckCommand(process.platform, process.env.ComSpec);
  const run = () =>
    execFileSync(command.command, command.args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.doesNotThrow(run, "an empty, matching workspace is in sync");

  writeFileSync(
    example,
    JSON.stringify({ name: "example", version: "1.0.0", dependencies: { semver: "7.7.4" } })
  );
  assert.throws(run, "a dependency missing from the lockfile must fail the gate");
});
