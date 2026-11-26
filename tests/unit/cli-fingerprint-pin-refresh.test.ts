/**
 * Pins refreshed against live captures (2026-11-25):
 *   - claude-code 2.1.332, captured on the wire through ANTHROPIC_BASE_URL
 *   - codex       0.172.0, read from openai/codex at the release tag
 *   - agy         1.5.17, captured on the wire through AGY_LLM_GATEWAY_URL
 *
 * These are the values upstream gates models on, so they are asserted literally
 * rather than relative to each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
  getClaudeCodeUserAgent,
} from "../../src/shared/constants/claudeCodeClient.ts";
import {
  DEFAULT_CODEX_CLIENT_VERSION,
  getCodexCliRsHeaders,
} from "../../src/shared/constants/codexClient.ts";
import {
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  getCachedAntigravityCliVersion,
} from "../../open-sse/services/antigravityVersion.ts";
import {
  antigravityCliUserAgent,
  resolveAntigravityCliChangelist,
} from "../../open-sse/services/antigravityHeaders.ts";
import { CLI_FINGERPRINTS } from "../../open-sse/config/cliFingerprints.ts";

const ROOT = new URL("../../", import.meta.url);

test("claude-code advertises the captured 2.1.332 build", () => {
  assert.equal(CLAUDE_CODE_CLIENT_VERSION, "2.1.332");
  assert.equal(getClaudeCodeUserAgent("cli"), "claude-cli/2.1.332 (external, cli)");
  assert.equal(getClaudeCodeUserAgent("sdk-cli"), "claude-cli/2.1.332 (external, sdk-cli)");
});

test("claude-code stainless metadata matches the captured SDK bundle", () => {
  // x-stainless-package-version / x-stainless-runtime-version on the capture.
  assert.equal(CLAUDE_CODE_SDK_PACKAGE_VERSION, "0.128.0");
  assert.equal(CLAUDE_CODE_RUNTIME_VERSION, "v26.12.1");
});

test("codex advertises the captured 0.172.0 build", () => {
  assert.equal(DEFAULT_CODEX_CLIENT_VERSION, "0.172.0");
  assert.ok(getCodexCliRsHeaders()["User-Agent"].startsWith("codex_cli_rs/0.172.0 ("));
});

test("the Dockerfile installs the same codex version the fingerprint advertises", () => {
  const dockerfile = readFileSync(new URL("Dockerfile", ROOT), "utf8");
  assert.ok(
    dockerfile.includes(`@openai/codex@${DEFAULT_CODEX_CLIENT_VERSION}`),
    `Dockerfile must pin @openai/codex@${DEFAULT_CODEX_CLIENT_VERSION}`
  );
});

test("agy advertises the captured 1.5.17 build with its own changelist", () => {
  assert.equal(ANTIGRAVITY_CLI_FALLBACK_VERSION, "1.5.17");
  assert.equal(getCachedAntigravityCliVersion(), "1.5.17");
  assert.equal(resolveAntigravityCliChangelist("1.5.17"), "1029496841");
  assert.equal(
    antigravityCliUserAgent("1.5.17", "consumer", "1029496841", {
      osType: "linux",
      arch: "amd64",
    }),
    "antigravity/cli/1.5.17 (aidev_client; os_type=linux; arch=amd64; cl=1029496841; auth_method=consumer)"
  );
});

test("the cold-start agy fingerprint carries no stale changelist", () => {
  // 1.3.4 had no changelist entry, so the pin shipped without `cl=` entirely.
  assert.equal(resolveAntigravityCliChangelist("1.3.4"), null);
  assert.ok(getCachedAntigravityCliVersion() !== "1.3.4");
});

test("the codex body field order is the real client's serialization order", () => {
  assert.deepEqual(CLI_FINGERPRINTS.codex?.bodyFieldOrder.slice(0, 8), [
    "model",
    "stream",
    "service_tier",
    "instructions",
    "input",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
  ]);
  assert.ok(CLI_FINGERPRINTS.codex?.bodyFieldOrder.includes("client_metadata"));
});

test("the claude header shape sends a per-attempt x-client-request-id", () => {
  // 2.1.332: `pr=hDe()?oLs():void 0` then `{[k_e]:pr}` — gated on first-party traffic
  // (`hDe()`) and minted with `import{randomUUID as oLs}from"crypto"`, fresh per
  // attempt. An earlier pass read the header as request-only bookkeeping and dropped
  // it; the gate is what settles it, because first-party is exactly our case.
  const base = readFileSync(new URL("open-sse/executors/base.ts", ROOT), "utf8");
  assert.match(base, /"x-client-request-id": randomUUID\(\)/);
  assert.match(base, /retryHeaders\["x-client-request-id"\] = randomUUID\(\)/);
});
