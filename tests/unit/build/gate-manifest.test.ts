import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  readManifest,
  validateManifest,
  resolveProfile,
} from "../../../scripts/quality/gate-manifest.mjs";

function fixture() {
  const scripts = { "check:a": "bun scripts/check/a.ts", "test:b": "node --test b.ts" };
  const manifest = {
    schemaVersion: 1,
    aliases: Object.entries(scripts).map(([name, command]) => ({
      name,
      command,
      disposition: "separately-invoked",
    })),
    profiles: {
      scan: { description: "Focused scan, not release acceptance", aliases: ["check:a"] },
    },
  };
  return { scripts, manifest };
}

test("manifest resolves the pnpm entrypoint, preserving its chosen runtime", () => {
  const { scripts, manifest } = fixture();
  assert.deepEqual(validateManifest(manifest, scripts), []);
  assert.deepEqual(resolveProfile(manifest, scripts, "scan"), [
    { name: "check:a", cmd: ["pnpm", "run", "--silent", "check:a"] },
  ]);
});

test("new validation aliases cannot silently evade the inventory", () => {
  const { scripts, manifest } = fixture();
  assert.match(
    validateManifest(manifest, { ...scripts, "check:new": "node new.mjs" }).join(),
    /unmapped.*check:new/
  );
});

test("removed aliases and changed commands invalidate the manifest", () => {
  const { manifest } = fixture();
  const errors = validateManifest(manifest, { "check:a": "node a.ts" }).join();
  assert.match(errors, /command.*check:a/);
  assert.match(errors, /removed.*test:b/);
});

test("duplicate inventory entries and profile members are rejected", () => {
  const { scripts, manifest } = fixture();
  manifest.aliases.push(manifest.aliases[0]);
  manifest.profiles.scan.aliases.push("check:a");
  assert.match(validateManifest(manifest, scripts).join(), /duplicate alias/);
  assert.match(validateManifest(manifest, scripts).join(), /duplicate profile member/);
});

test("unknown or empty profiles never report a successful scan", () => {
  const { scripts, manifest } = fixture();
  assert.throws(() => resolveProfile(manifest, scripts, "typo"), /unknown profile/);
  manifest.profiles.scan.aliases = [];
  assert.throws(() => resolveProfile(manifest, scripts, "scan"), /empty profile/);
});

test("maintenance commands cannot be selected as read-only gates", () => {
  const { scripts, manifest } = fixture();
  manifest.aliases[0].disposition = "maintenance";
  assert.throws(() => resolveProfile(manifest, scripts, "scan"), /maintenance/);
});

test("schema and unrecognized dispositions fail closed", () => {
  const { scripts, manifest } = fixture();
  manifest.schemaVersion = 99;
  manifest.aliases[0].disposition = "trust-me";
  assert.match(validateManifest(manifest, scripts).join(), /schema/);
  assert.match(validateManifest(manifest, scripts).join(), /disposition/);
});

test("the committed inventory covers current scripts without command drift", () => {
  const manifest = JSON.parse(readFileSync("config/quality/gate-manifest.json", "utf8"));
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(validateManifest(manifest, scripts), []);
  const full = resolveProfile(manifest, scripts, "quality-scan");
  const fast = resolveProfile(manifest, scripts, "quality-scan-fast");
  assert.ok(full.length >= fast.length);
  assert.ok(fast.every((gate) => full.some((other) => other.name === gate.name)));
  assert.ok(full.some((gate) => gate.name === "check:gate-manifest"));
});

test("real aggregator list mode uses the manifest without running any gate", () => {
  const manifest = JSON.parse(readFileSync("config/quality/gate-manifest.json", "utf8"));
  for (const [flags, profile] of [
    [[], "quality-scan"],
    [["--fast"], "quality-scan-fast"],
  ] as const) {
    const actual = JSON.parse(
      execFileSync(process.execPath, ["scripts/quality/run-all-gates.mjs", ...flags, "--list"], {
        encoding: "utf8",
        timeout: 15_000,
      })
    );
    assert.equal(actual.profile, profile);
    assert.deepEqual(actual.aliases, manifest.profiles[profile].aliases);
    assert.equal(actual.releaseAcceptance, false);
  }
});

test("every static scan alias resolves to a package script", () => {
  const manifest = JSON.parse(readFileSync("config/quality/gate-manifest.json", "utf8"));
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const profile of ["quality-scan", "quality-scan-fast"]) {
    const gates = resolveProfile(manifest, scripts, profile);
    assert.ok(gates.length > 0, profile);
    for (const gate of gates) assert.ok(scripts[gate.name], `${profile}: ${gate.name}`);
  }
});

function writeFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gate-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { scripts, manifest } = fixture();
  mkdirSync(join(root, "config/quality"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, "config/quality/gate-manifest.json"), JSON.stringify(manifest));
  return { root, manifest, scripts };
}

test("readManifest returns the manifest and package scripts", (t) => {
  const { root, manifest, scripts } = writeFixture(t);
  assert.deepEqual(readManifest(root), { manifest, scripts });
});

test("inventory CLI validates the manifest without node_modules before install", (t) => {
  const { root } = writeFixture(t);
  mkdirSync(join(root, "scripts/quality"), { recursive: true });
  copyFileSync(
    new URL("../../../scripts/quality/gate-manifest.mjs", import.meta.url),
    join(root, "scripts/quality/gate-manifest.mjs")
  );
  assert.equal(existsSync(join(root, "node_modules")), false);
  const invoke = () =>
    spawnSync(process.execPath, ["scripts/quality/gate-manifest.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
  const valid = invoke();
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    schemaVersion: 1,
    aliases: 2,
    profiles: { scan: 1 },
    releaseAcceptance: false,
  });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
  const invalid = invoke();
  assert.equal(invalid.status, 1, invalid.stderr);
});
