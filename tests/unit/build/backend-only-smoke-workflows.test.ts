// Regression guard for #7226: the backend-only build profile skips the dashboard UI graph
// (scripts/build/backendOnlyPages.mjs). The workflow-level checks that pinned the API-only
// smoke/nightly workflows to it were removed with those workflows.
import test from "node:test";
import assert from "node:assert/strict";
import { isBackendOnlyBuild } from "../../../scripts/build/backendOnlyPages.mjs";

test("contributor build profile enables backend-only mode", () => {
  assert.equal(isBackendOnlyBuild({ OMNIROUTE_BUILD_PROFILE: "contributor" }), true);
});

test("full build remains the default when no backend-only profile is set", () => {
  assert.equal(isBackendOnlyBuild({}), false);
});
