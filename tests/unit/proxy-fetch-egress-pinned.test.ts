/**
 * Egress pinning for subscription OAuth accounts.
 *
 * The proxy pool may rotate a connection's egress between requests. For an
 * account-scoped OAuth subscription that is a ban signal — the account appears
 * used from several places at once — while it buys nothing (the limits are not
 * IP-bucketed, so fragmenting has no upside).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  egressPinnedProviders,
  egressIpLockProvidersFromEnv,
  isEgressPinnedScope,
} from "../../open-sse/config/providerErrorRules.ts";

const ROOT = new URL("../../", import.meta.url);

test("subscription OAuth providers are pinned by default", () => {
  for (const provider of ["claude", "codex", "agy", "antigravity", "copilot"]) {
    assert.equal(isEgressPinnedScope(provider), true, `${provider} must be pinned`);
  }
});

test("the match is case-insensitive and nil-safe", () => {
  assert.equal(isEgressPinnedScope("CLAUDE"), true);
  assert.equal(isEgressPinnedScope(null), false);
  assert.equal(isEgressPinnedScope(undefined), false);
  assert.equal(isEgressPinnedScope(""), false);
});

test("non-subscription providers keep rotating", () => {
  for (const provider of ["openrouter", "nvidia", "gemini"]) {
    assert.equal(isEgressPinnedScope(provider), false, `${provider} must not be pinned`);
  }
});

test("the pinned allowlist is exportable for data callers", () => {
  const list = egressPinnedProviders();
  assert.ok(list.includes("claude"));
  assert.deepEqual([...list].sort(), list, "the allowlist must come back sorted");
});

test("the env parser behind the pin list keeps its documented semantics", () => {
  const fallback = { claude: true as const };
  assert.deepEqual([...egressIpLockProvidersFromEnv(undefined, fallback)], ["claude"]);
  for (const off of ["none", "off", "false", "0", " NONE "]) {
    assert.equal(egressIpLockProvidersFromEnv(off, fallback).size, 0);
  }
  assert.deepEqual([...egressIpLockProvidersFromEnv(" a, B ,, c ", fallback)].sort(), [
    "a",
    "b",
    "c",
  ]);
});

test("settings treats a pinned provider as requiring stable egress", () => {
  const settings = readFileSync(new URL("src/lib/db/settings.ts", ROOT), "utf8");
  assert.match(
    settings,
    /isEgressBucketedLockScope\(provider\) \|\| isEgressPinnedScope\(provider\)/
  );
});
