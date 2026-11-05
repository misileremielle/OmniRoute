import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const m = await import("../../scripts/check/check-ui-kit-upstream.mjs");

test("latestTag picks the highest vX.Y.Z and the peeled commit of annotated tags", () => {
  const out = [
    "1111111111111111111111111111111111111111\trefs/tags/v0.0.9",
    "2222222222222222222222222222222222222222\trefs/tags/v0.0.76",
    "3333333333333333333333333333333333333333\trefs/tags/v0.0.76^{}",
    "4444444444444444444444444444444444444444\trefs/tags/v0.0.66",
    "5555555555555555555555555555555555555555\trefs/tags/not-a-release",
  ].join("\n");
  assert.deepEqual(m.latestTag(out), {
    version: "0.0.76",
    commit: "3333333333333333333333333333333333333333",
  });
  assert.equal(m.latestTag(""), null);
});

test("compareVersions orders numerically, not lexically", () => {
  assert.equal(m.compareVersions("0.0.76", "0.0.9"), 1);
  assert.equal(m.compareVersions("0.0.66", "0.0.76"), -1);
  assert.equal(m.compareVersions("0.1.0", "0.1.0"), 0);
});

test("pinnedVersion reads UPSTREAM.md, and the vendored kit is not behind the pin it records", async () => {
  const md = fs.readFileSync("packages/ui-kit/UPSTREAM.md", "utf8");
  const pinned = m.pinnedVersion(md);
  assert.match(pinned.version, /^\d+\.\d+\.\d+$/);
  assert.match(pinned.commit, /^[0-9a-f]{40}$/);
  const pkg = JSON.parse(fs.readFileSync("packages/ui-kit/package.json", "utf8"));
  assert.equal(pkg.version, pinned.version);
});

function tempDir(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-kit-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stub(dir: string, name: string, body: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

const NO_TOKEN = m.describeUnknown({ tokenSet: false, listingFailed: true });
const LISTING_FAILED = m.describeUnknown({ tokenSet: true, listingFailed: true });

test("describeUnknown only blames a missing token when the token really is missing", () => {
  assert.equal(NO_TOKEN.reason, "no-token");
  assert.match(NO_TOKEN.detail, /UI_KIT_READ_TOKEN isn't set/);

  assert.equal(LISTING_FAILED.reason, "listing-failed");
  assert.doesNotMatch(LISTING_FAILED.detail, /isn't set|missing/);
  assert.match(LISTING_FAILED.detail, /invalid/);
  assert.match(LISTING_FAILED.detail, /unreachable/);

  // The listing worked, so neither the token nor the network is at fault, with or without a token.
  for (const tokenSet of [true, false]) {
    const noTags = m.describeUnknown({ tokenSet, listingFailed: false });
    assert.equal(noTags.reason, "no-release-tags");
    assert.doesNotMatch(noTags.detail, /token/i);
  }
});

test("the script reports the right reason for each way of ending up unknown", (t) => {
  const bin = path.join(tempDir(t), "bin");
  const run = (gitBody: string, token: string | undefined) => {
    stub(bin, "git", gitBody);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.UI_KIT_READ_TOKEN;
    if (token !== undefined) env.UI_KIT_READ_TOKEN = token;
    const res = spawnSync(process.execPath, ["scripts/check/check-ui-kit-upstream.mjs", "--json"], {
      encoding: "utf8",
      env,
    });
    assert.equal(res.status, 0, "an unknown state never fails the check");
    return JSON.parse(res.stdout);
  };

  // The workflow passes an unset secret as an empty string, so that has to count as unset.
  for (const token of [undefined, ""]) {
    const report = run("exit 128", token);
    assert.equal(report.state, "unknown");
    assert.equal(report.reason, "no-token");
  }
  const rejected = run("exit 128", "ghp_not_a_real_token");
  assert.equal(rejected.state, "unknown");
  assert.equal(rejected.reason, "listing-failed");
  assert.ok(
    !JSON.stringify(rejected).includes("ghp_not_a_real_token"),
    "token stays out of the report"
  );

  const noTags = run("exit 0", "ghp_not_a_real_token");
  assert.equal(noTags.state, "unknown");
  assert.equal(noTags.reason, "no-release-tags");

  // A readable upstream carries no reason, so nothing downstream can mistake it for a failure.
  const tags = `echo "${"a".repeat(40)}\trefs/tags/v0.0.0"`;
  const known = run(tags, "ghp_not_a_real_token");
  assert.equal(known.state, "up-to-date");
  assert.equal(known.reason, undefined);
  assert.equal(known.detail, undefined);
});
