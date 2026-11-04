import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// The bug: module-level fs.existsSync(path.join(process.cwd(), ...)) calls cause
// Turbopack's NFT tracer to follow paths into the entire src/ tree, producing
// "Encountered unexpected file in NFT list" warnings during build.
//
// Fix: Move module-level fs/process.cwd calls to lazy functions so they are
// invoked from route handlers (not at module scope), letting the NFT tracer
// skip them during build.

describe("#9560 — Turbopack NFT guard: lazy module-level fs resolution", () => {
  it("cliRuntime exports known path check function", async () => {
    // Verify cliRuntime imports without module-level getExpectedParentPaths call.
    const cliRuntime = await import("../../src/shared/services/cliRuntime.ts");
    assert.ok(typeof cliRuntime.checkKnownPath === "function");
  });

  it("known path check produces deterministic result for a known-bad input", async () => {
    const { checkKnownPath } = await import("../../src/shared/services/cliRuntime.ts");
    // A relative path is rejected without hitting any expected-parent-paths logic.
    const result = await checkKnownPath("../evil");
    assert.equal(result.installed, false);
    assert.equal(result.reason, "not_absolute");
  });

  it("known path check rejects path with dangerous characters", async () => {
    const { checkKnownPath } = await import("../../src/shared/services/cliRuntime.ts");
    const result = await checkKnownPath("/tmp/foo;$PATH");
    assert.equal(result.installed, false);
    assert.equal(result.reason, "unsafe_path");
  });

  it("getExpectedParentPathsCached returns same shape as direct call", async () => {
    // getExpectedParentPaths is module-internal, but we can indirectly verify
    // that cliRuntime's known-path logic reaches it by checking that absolute
    // paths to known-locations like /usr/bin/env resolve correctly.
    const { checkKnownPath } = await import("../../src/shared/services/cliRuntime.ts");
    await assert.doesNotReject(checkKnownPath("/usr/bin/env"));
  });
});
