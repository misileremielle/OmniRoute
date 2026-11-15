/**
 * npm publish-path helpers for test/spec leaks (#3821).
 *
 * Unit tests use the static `files` allowlist (no subprocess). The pack-artifact
 * gate uses the same helpers against a real `npm pack --dry-run --ignore-scripts`
 * file list so concurrent unit suites never shell out to `npm pack`.
 */

import { normalizeArtifactPath } from "./pack-artifact-policy.ts";

/** Co-located test / spec paths that must never ship in the npm tarball. */
export const PACK_ARTIFACT_TEST_FILE_RE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Negations that must stay in package.json `files` (static unit guard). */
export const REQUIRED_PACKAGE_FILES_TEST_NEGATIONS: readonly string[] = [
  "!**/__tests__/**",
  "!**/*.test.ts",
  "!**/*.test.tsx",
  "!**/*.test.js",
  "!**/*.test.mjs",
  "!**/*.spec.ts",
  "!**/*.spec.tsx",
];

/** Whether `file` is covered by a package.json `files` allowlist entry. */
export function isCoveredByFiles(file: string, filesEntries: string[]): boolean {
  for (const entry of filesEntries) {
    if (entry.startsWith("!")) continue; // negations are not positive coverage
    if (entry.endsWith("/")) {
      if (file === entry.slice(0, -1) || file.startsWith(entry)) return true;
    } else if (file === entry || file.startsWith(entry + "/")) {
      return true;
    }
  }
  return false;
}

/** Packed paths that look like test / spec files (over-inclusion). */
export function findLeakedTestArtifactPaths(filePaths: string[]): string[] {
  return filePaths
    .map(normalizeArtifactPath)
    .filter(Boolean)
    .filter((filePath) => PACK_ARTIFACT_TEST_FILE_RE.test(filePath))
    .sort();
}

/** Required `files` negation entries that are absent from package.json. */
export function findMissingPackageFilesTestNegations(filesEntries: string[]): string[] {
  const present = new Set(filesEntries);
  return REQUIRED_PACKAGE_FILES_TEST_NEGATIONS.filter((entry) => !present.has(entry));
}
