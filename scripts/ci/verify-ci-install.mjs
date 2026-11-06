#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importerDependency, parsePnpmLock } from "./pnpmLock.mjs";

function verifyDirectDependencyVersions(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lockText = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  const lock = parsePnpmLock(lockText);
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const entries = Object.entries(declared);
  assert.ok(entries.length > 0, "missing declared dependencies for install verification");
  for (const [name, spec] of entries) {
    assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, "invalid dependency name");
    const locked = importerDependency(lock, name);
    assert.equal(locked?.specifier, spec, `${name}: declaration differs from lockfile`);
    assert.ok(locked.version?.length > 0, `${name}: missing resolved version in lockfile`);
    const installed = JSON.parse(
      readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")
    );
    assert.equal(
      installed.version,
      locked.version,
      `${name}: installed version differs from lockfile (expected ${locked.version})`
    );
  }
  return {
    status: "PASS",
    checked: entries.length,
    lockfileSha256: createHash("sha256").update(lockText).digest("hex"),
  };
}

/** Version parity and native operations do not replace a clean-install receipt. */
export function verifyCiInstall(root = process.cwd()) {
  const dependencies = verifyDirectDependencyVersions(root);
  const requireFromRoot = createRequire(resolve(root, "package.json"));
  const Database = requireFromRoot("better-sqlite3");
  const database = new Database(":memory:");
  try {
    const row = database.prepare("SELECT 42 AS value").get();
    assert.equal(row?.value, 42, "SQLite native query returned an unexpected result");
  } finally {
    database.close();
  }
  const esbuild = requireFromRoot("esbuild");
  const transformed = esbuild.transformSync("const value: number = 1;", { loader: "ts" });
  assert.ok(
    typeof transformed.code === "string" && transformed.code.length > 0,
    "esbuild native transform produced no output"
  );
  return {
    dependencies,
    sqlite: "PASS",
    esbuild: "PASS",
    node: process.version,
    abi: process.versions.modules,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    console.log(`[verify-ci-install] ${JSON.stringify(verifyCiInstall())}`);
  } catch (error) {
    console.error(`[verify-ci-install] unusable dependency installation: ${error.message}`);
    process.exitCode = 1;
  }
}
