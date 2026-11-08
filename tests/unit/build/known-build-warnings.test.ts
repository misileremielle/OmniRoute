/**
 * The infrastructure-log filter swallows the known, non-actionable webpack
 * build-dependency warning for allow-listed third-party bundles and forwards
 * everything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterKnownInfrastructureWarnings,
  isKnownInfrastructureBuildDependencyWarning,
  isNextIntlExtractorDynamicImportWarning,
} from "../../../scripts/build/knownBuildWarnings.mjs";

const ISSUE_WARNING = [
  "[webpack.cache.PackFileCacheStrategy/webpack.FileSystemInfo] Parsing of",
  "/home/temp/OmniRoute/node_modules/next-intl/dist/esm/production/extractor/format/index.js",
  "for build dependencies failed at 'import(pathToFileURL(outfile).href)'.",
  "Build dependencies behind this expression are ignored and might cause incorrect cache invalidation.",
].join(" ");

test("the next-intl extractor build-dependency warning is recognized", () => {
  assert.equal(isKnownInfrastructureBuildDependencyWarning([ISSUE_WARNING]), true);
});

test("Windows-style backslash paths are normalized before matching", () => {
  const warning = ISSUE_WARNING.replaceAll("/", "\\");
  assert.equal(isKnownInfrastructureBuildDependencyWarning([warning]), true);
});

test("an unrelated FileSystemInfo warning is not swallowed", () => {
  const warning = [
    "[webpack.cache.PackFileCacheStrategy/webpack.FileSystemInfo] Parsing of",
    "/repo/node_modules/some-other-lib/dist/index.js",
    "for build dependencies failed at 'import(expr)'.",
    "Build dependencies behind this expression are ignored and might cause incorrect cache invalidation.",
  ].join(" ");
  assert.equal(isKnownInfrastructureBuildDependencyWarning([warning]), false);
});

test("filterKnownInfrastructureWarnings drops known noise and forwards everything else", () => {
  const seen = [];
  const baseConsole = { warn: (...args) => seen.push(args) };
  const filtered = filterKnownInfrastructureWarnings(baseConsole);

  filtered.warn(ISSUE_WARNING);
  filtered.warn("a genuine warning");

  assert.deepEqual(seen, [["a genuine warning"]]);
});

test("isNextIntlExtractorDynamicImportWarning matches only the extractor resource", () => {
  const resource = "node_modules/next-intl/dist/esm/production/extractor/format/index.js";
  assert.equal(
    isNextIntlExtractorDynamicImportWarning({
      module: { resource },
      message: "the request of a dependency is an expression",
    }),
    true
  );
  assert.equal(
    isNextIntlExtractorDynamicImportWarning({
      module: { resource: "node_modules/other/index.js" },
      message: "the request of a dependency is an expression",
    }),
    false
  );
});
