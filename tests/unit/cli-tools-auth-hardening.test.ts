import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(THIS_FILE);
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");

test("the logs tail route (the remaining requireCliToolsAuth consumer) guards its handler", () => {
  const relPath = "src/app/api/logs/tail/route.ts";
  const content = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const handlerCount = (content.match(/export async function (GET|POST|PUT|DELETE)\(/g) || [])
    .length;
  const authCount = (
    content.match(
      /const authError = await requireCliToolsAuth\(request(?:, \{ alwaysRequireAuth: true \})?\);/g
    ) || []
  ).length;
  const returnCount = (
    content.match(
      /if \(authError\) (?:return authError;|\{\s*authError\.headers\.set\("cache-control", "no-store"\);\s*return authError;\s*\})/g
    ) || []
  ).length;

  assert.ok(handlerCount > 0, `${relPath} should export at least one route handler`);
  assert.ok(
    content.includes('from "@/lib/api/requireCliToolsAuth"'),
    `${relPath} should import requireCliToolsAuth`
  );
  assert.equal(
    authCount,
    handlerCount,
    `${relPath} should guard every exported handler before host access`
  );
  assert.equal(
    returnCount,
    handlerCount,
    `${relPath} should return the auth error from every exported handler`
  );
});

test("cli-tools auth helper delegates to management auth", () => {
  const helperPath = path.join(REPO_ROOT, "src/lib/api/requireCliToolsAuth.ts");
  const content = fs.readFileSync(helperPath, "utf8");

  assert.ok(
    content.includes('from "@/lib/api/requireManagementAuth"'),
    "requireCliToolsAuth should reuse the shared management auth helper"
  );
  assert.ok(
    content.includes("return requireManagementAuth(request);") ||
      content.includes("return requireManagementAuth(request, options);"),
    "requireCliToolsAuth should delegate directly to requireManagementAuth"
  );
});
