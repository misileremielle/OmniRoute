// With login disabled (requireLogin=false, the "local-first" mode `omniroute setup` and the
// onboarding "skip" write), every MANAGEMENT route is anonymous unless it is in
// ALWAYS_PROTECTED_API_PATHS. These routes restart the process or ship call
// logs to a caller-chosen BigQuery project, while their same-effect
// siblings (/api/logs/export, /api/shutdown) were already protected.
// They now require a dashboard session or a manage-scoped key in every mode.
//
// Anonymous calls send an invalid JSON body: before the fix they passed the auth gate and
// stopped at the 400 "invalid JSON" branch, so the RED run has no side effects.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mgmt-writers-"));
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  JWT_SECRET: process.env.JWT_SECRET,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "mgmt-writers-api-key-secret";
process.env.JWT_SECRET = "mgmt-writers-jwt-secret";

const core = await import("../../src/lib/db/core.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { isAlwaysProtectedPath } = await import("../../src/server/authz/routeGuard.ts");
const restartRoute = await import("../../src/app/api/restart/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const BASE = "http://localhost:20128";
function anonymous(pathname: string, method = "GET"): Request {
  return new Request(`${BASE}${pathname}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : "not-json",
  });
}

async function assertUnauthenticated(label: string, response: Response): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 401, `${label}: expected 401, got ${response.status}: ${text}`);
  assert.ok(!text.includes("at /"), `${label}: 401 body must not leak a stack trace`);
}

async function withLoginDisabled(run: () => Promise<void>): Promise<void> {
  await updateSettings({ requireLogin: false, setupComplete: true });
  try {
    await run();
  } finally {
    await updateSettings({ requireLogin: true });
  }
}

test("the central route guard always protects the restart route", () => {
  assert.equal(
    isAlwaysProtectedPath("/api/restart"),
    true,
    "/api/restart must be ALWAYS_PROTECTED"
  );
});

test("with login disabled, anonymous callers cannot restart the server", async (t) => {
  const kill = t.mock.method(process, "kill", () => true);
  try {
    await withLoginDisabled(async () => {
      await assertUnauthenticated(
        "POST /api/restart",
        await restartRoute.POST(anonymous("/api/restart", "POST"))
      );
    });
  } finally {
    // A restart that slipped through schedules SIGTERM 500 ms later; wait past it here so
    // the signal is counted by this test, not the next one.
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
  assert.equal(kill.mock.callCount(), 0, "an anonymous restart must not signal the process");
});
