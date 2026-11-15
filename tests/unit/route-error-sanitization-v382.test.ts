/**
 * Static guard tests for the error-sanitization fixes in release/v3.8.2.
 *
 * Review findings: two authenticated routes returned raw error text in their
 * HTTP body (`(error as Error).message` / `String(error)`), violating the
 * project's error-sanitization policy (CLAUDE.md hard rule 12,
 * docs/security/ERROR_SANITIZATION.md). These guards pin the fix in source so
 * the anti-pattern cannot silently return. (Static-source assertions pin the fix in source.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRoute(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const CACHE_STATS = "src/app/api/cache/stats/route.ts";
const COPILOT_CHAT = "src/app/api/copilot/chat/route.ts";

test("cache/stats route routes errors through sanitizeErrorMessage", () => {
  const src = readRoute(CACHE_STATS);
  assert.match(src, /import \{ sanitizeErrorMessage \}/, "must import sanitizeErrorMessage");
  assert.match(src, /sanitizeErrorMessage\(error\)/, "catch blocks must sanitize the error");
  assert.ok(
    !/\(error as Error\)\.message/.test(src),
    "must not put raw (error as Error).message in the response body"
  );
});

test("copilot chat route requires management auth and sanitizes thrown errors", () => {
  const src = readRoute(COPILOT_CHAT);
  assert.match(src, /requireManagementAuth/, "route should enforce management auth");
  assert.match(src, /const authError = await requireManagementAuth\(request\);/);
  assert.match(src, /sanitizeErrorMessage\(error\)/, "catch blocks must sanitize errors");
  assert.ok(!/error\.message/.test(src), "must not return raw error.message");
});
