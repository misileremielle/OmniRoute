/**
 * The four spoofed CLI fingerprints are captured pins. Upstream gates new
 * models on the advertised client version, so a pin that lags the published
 * CLI is a silent 400, not a cosmetic mismatch.
 *
 * This test does not hit the network. It feeds a published-version map into
 * the same comparison the check script uses, and proves a stale pin fails
 * while an equal pin passes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  compareFingerprintPins,
  exitCodeForFingerprintCheck,
  platformVersionFromLauncherDeps,
  FINGERPRINT_SOURCES,
  type FingerprintDrift,
  type FingerprintId,
  type PublishedCliVersion,
} from "../../scripts/check/check-cli-fingerprint-drift.ts";

const PINS = Object.fromEntries(
  FINGERPRINT_SOURCES.map((source) => [source.id, source.pinned])
) as Record<FingerprintId, string>;

function published(version: string): PublishedCliVersion {
  return { version, source: "test" };
}

test("a pin behind the published CLI is drift even when the other three match", () => {
  const drift = compareFingerprintPins(
    { ...PINS, "claude-code": "0.0.1" },
    {
      "claude-code": published("2.1.280"),
      codex: published(PINS.codex),
      copilot: published(PINS.copilot),
      "grok-build": published(PINS["grok-build"]),
      antigravity: published(PINS.antigravity),
    }
  );

  assert.deepEqual(
    drift.map((row) => row.id),
    ["claude-code"]
  );
  assert.equal(drift[0]?.pinned, "0.0.1");
  assert.equal(drift[0]?.published, "2.1.280");
});

test("pins that match the published CLI are not drift", () => {
  const drift = compareFingerprintPins(PINS, {
    "claude-code": published(PINS["claude-code"]),
    codex: published(PINS.codex),
    copilot: published(PINS.copilot),
    "grok-build": published(PINS["grok-build"]),
    antigravity: published(PINS.antigravity),
  });

  assert.deepEqual(drift, []);
});

test("a missing published version is reported, not treated as equal", () => {
  const drift = compareFingerprintPins(PINS, {
    "claude-code": null,
    codex: published(PINS.codex),
    copilot: published(PINS.copilot),
    "grok-build": published(PINS["grok-build"]),
    antigravity: published(PINS.antigravity),
  });

  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.published, null);
});

const ONE_DRIFT: FingerprintDrift[] = [
  { id: "codex", pinned: "0.0.1", published: "9.9.9", source: "test" },
];

test("one unreachable registry exits 0 even when another pin is already behind", () => {
  assert.equal(exitCodeForFingerprintCheck(["claude-code: ENOTFOUND"], ONE_DRIFT), 0);
});

test("drift exits 1 only when every published version was read", () => {
  assert.equal(exitCodeForFingerprintCheck([], ONE_DRIFT), 1);
  assert.equal(exitCodeForFingerprintCheck([], []), 0);
});

test("grok reads the platform binary package, not the launcher", () => {
  const grok = FINGERPRINT_SOURCES.find((source) => source.id === "grok-build");
  assert.equal(grok?.platformPackage, "@xai-official/grok-linux-x64");
  assert.notEqual(grok?.platformPackage, grok?.npmPackage);
});

test("grok's wire version is the platform binary the launcher installs, not the platform package's latest tag", () => {
  // Captured 2026-09-25: `@xai-official/grok@1.0.92` pins every platform binary
  // to 1.0.92, and that binary hardcodes `x-grok-client-version: 1.0.92`. The
  // platform package's own `latest` dist-tag is frozen at 0.1.220 (May 2026),
  // so `npm view @xai-official/grok-linux-x64 version` reports a binary nobody
  // installs any more.
  const launcherOptionalDeps = {
    "@xai-official/grok-linux-x64": "1.0.92",
    "@xai-official/grok-darwin-arm64": "1.0.92",
  };
  assert.equal(
    platformVersionFromLauncherDeps(launcherOptionalDeps, "@xai-official/grok-linux-x64"),
    "1.0.92"
  );
  assert.equal(
    platformVersionFromLauncherDeps([launcherOptionalDeps], "@xai-official/grok-linux-x64"),
    "1.0.92",
    "npm view --json wraps the field in an array when the version has two dist-tags"
  );
  assert.equal(platformVersionFromLauncherDeps({}, "@xai-official/grok-linux-x64"), null);
  assert.equal(
    platformVersionFromLauncherDeps(
      { "@xai-official/grok-linux-x64": "^1.0.0" },
      "@xai-official/grok-linux-x64"
    ),
    null,
    "a range is not a pinned binary version"
  );
});

test("the grok pin matches the platform binary shipped by the published launcher", () => {
  const grok = FINGERPRINT_SOURCES.find((source) => source.id === "grok-build");
  assert.equal(grok?.pinned, "1.0.92");
});

test("antigravity is covered by the gate and reads its GitHub release, not an npm package", () => {
  // `agy` ships only as release assets, so the npm path cannot see it: the pin sat
  // at 1.3.4 while 1.5.17 was published, and nothing failed.
  const agy = FINGERPRINT_SOURCES.find((source) => source.id === "antigravity");
  assert.equal(agy?.githubRepo, "google-antigravity/antigravity-cli");
  assert.equal(agy?.npmPackage, "");
  assert.equal(agy?.pinned, "1.5.17");
});

test("the four npm-sourced fingerprints keep an npm package and no GitHub repo", () => {
  for (const source of FINGERPRINT_SOURCES.filter((s) => s.id !== "antigravity")) {
    assert.ok(source.npmPackage.length > 0, `${source.id} must keep an npm package`);
    assert.equal(source.githubRepo, undefined, `${source.id} must not switch to GitHub`);
  }
});

// --- Tolerated versus blocking drift -------------------------------------
// Copilot publishes most days. Blocking every PR on a one-patch publish taught
// people to ignore the gate, so only a MAJOR/MINOR gap (what the vendor gates
// models on) or a deeply rotted pin fails the check.

const MATCH_ALL = {
  "claude-code": published(PINS["claude-code"]),
  codex: published(PINS.codex),
  copilot: published(PINS.copilot),
  "grok-build": published(PINS["grok-build"]),
  antigravity: published(PINS.antigravity),
};

function classify(pinned: string, live: string): FingerprintDrift | undefined {
  const drift = compareFingerprintPins(
    { ...PINS, copilot: pinned },
    { ...MATCH_ALL, copilot: published(live) }
  );
  return drift.find((row) => row.id === "copilot");
}

test("a one-patch gap is advisory, not a failure", () => {
  const row = classify("1.0.10", "1.0.11");
  assert.equal(row?.severity, "patch");
  assert.equal(row?.patchDistance, 1);
  assert.equal(exitCodeForFingerprintCheck([], [row as FingerprintDrift]), 0);
});

test("a patch gap past the tolerance fails", () => {
  const row = classify("1.0.10", "1.0.15") as FingerprintDrift;
  assert.equal(row.severity, "patch");
  assert.equal(row.patchDistance, 5);
  assert.equal(exitCodeForFingerprintCheck([], [row]), 1);
});

test("--strict collapses the tolerance", () => {
  const row = classify("1.0.10", "1.0.11") as FingerprintDrift;
  assert.equal(exitCodeForFingerprintCheck([], [row], 0), 1);
});

test("a minor or major gap always fails", () => {
  const minor = classify("1.0.10", "1.1.0") as FingerprintDrift;
  assert.equal(minor.severity, "minor");
  assert.equal(exitCodeForFingerprintCheck([], [minor]), 1);

  const major = classify("1.0.10", "2.0.0") as FingerprintDrift;
  assert.equal(major.severity, "major");
  assert.equal(exitCodeForFingerprintCheck([], [major]), 1);
});

test("a pin ahead of the published CLI never fails", () => {
  const row = classify("1.0.20", "1.0.10") as FingerprintDrift;
  assert.equal(row.severity, "ahead");
  assert.equal(exitCodeForFingerprintCheck([], [row]), 0);
});

test("an unparseable version is blocking rather than silently tolerated", () => {
  const row = classify("1.0.10-beta.1", "1.0.12") as FingerprintDrift;
  assert.equal(row.severity, "unknown");
  assert.equal(exitCodeForFingerprintCheck([], [row]), 1);
});
