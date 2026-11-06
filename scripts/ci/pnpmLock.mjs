// Read-only helpers for pnpm-lock.yaml. The file can hold two YAML documents: the first
// pins the pnpm version itself, the last is the dependency lockfile.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAll } from "js-yaml";

/** @param {string} text */
export function parsePnpmLock(text) {
  const lock = loadAll(text).findLast((doc) => doc?.importers);
  if (!lock) throw new Error("pnpm-lock.yaml has no importers document");
  return lock;
}

/** @param {string} [root] */
export function readPnpmLock(root = process.cwd()) {
  return parsePnpmLock(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
}

/** Drops the peer suffix pnpm appends to a version: `1.2.3(react@19.0.0)` -> `1.2.3`. */
export function stripPeerSuffix(version) {
  return String(version).split("(")[0];
}

/**
 * The declared specifier and resolved version of a direct dependency.
 * @returns {{ specifier: string, version: string } | undefined}
 */
export function importerDependency(lock, name, importer = ".") {
  const entry = lock.importers?.[importer];
  const found =
    entry?.dependencies?.[name] ??
    entry?.devDependencies?.[name] ??
    entry?.optionalDependencies?.[name];
  return (
    found && {
      specifier: found.specifier,
      version: found.version && stripPeerSuffix(found.version),
    }
  );
}

/** Every locked version of a package, sorted. */
export function lockedVersions(lock, name) {
  const prefix = `${name}@`;
  return Object.keys(lock.packages ?? {})
    .filter((key) => key.startsWith(prefix))
    .map((key) => stripPeerSuffix(key.slice(prefix.length)))
    .sort();
}

/** Resolved snapshots of a package, as `[version, snapshot]` pairs. */
export function packageSnapshots(lock, name) {
  const prefix = `${name}@`;
  return Object.entries(lock.snapshots ?? {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, snapshot]) => [stripPeerSuffix(key.slice(prefix.length)), snapshot ?? {}]);
}

/** Names of every package that declares `name` as a dependency, sorted. */
export function dependentsOf(lock, name) {
  const dependents = new Set();
  for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
    if (snapshot?.dependencies?.[name] || snapshot?.optionalDependencies?.[name]) {
      dependents.add(key.slice(0, key.indexOf("@", 1)));
    }
  }
  return [...dependents].sort();
}
