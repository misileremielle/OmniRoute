/**
 * Remote dashboards (managed instances, tunnels, reverse proxies) could never load the
 * read-only Resilience > Connections view (GET /api/resilience/connections, KEA-9357),
 * because its JSON sat behind the loopback-only tier. The read spawns nothing: SQLite reads
 * plus in-memory breaker state.
 *
 * /api/resilience/connections stays LOCAL_ONLY and is in the DEFAULT manage-scope bypass list.
 * A remote caller therefore needs an authenticated dashboard session or a manage-scope key;
 * an anonymous remote caller still gets 403 LOCAL_ONLY, even when requireLogin=false.
 *
 * Fork: upstream's Skills > Executions half (KEA-9359) and the /api/mcp/ bypass entry are
 * gone with the removed Skills and MCP features (docs/ops/FORK_IDENTITY.md).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { cleanupTempDataDir } from "../../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-remote-readonly-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const runtime = await import("../../../src/lib/config/runtimeSettings.ts");
const routeGuard = await import("../../../src/server/authz/routeGuard.ts");
const { SPAWN_CAPABLE_PREFIXES } =
  await import("../../../src/shared/constants/spawnCapablePrefixes.ts");

const RESILIENCE = "/api/resilience/connections";

const ORIGINAL_JWT = process.env.JWT_SECRET;
const ORIGINAL_INITIAL = process.env.INITIAL_PASSWORD;

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  runtime.resetRuntimeSettingsStateForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.JWT_SECRET;
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(() => {
  reset();
});

test.after(async () => {
  core.resetDbInstance();
  runtime.resetRuntimeSettingsStateForTests();
  await cleanupTempDataDir(TEST_DATA_DIR);
  if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT;
  if (ORIGINAL_INITIAL === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL;
});

async function loadPolicy() {
  const mod = await import(`../../../src/server/authz/policies/management.ts?ts=${Date.now()}`);
  return mod.managementPolicy;
}

async function dashboardCookieHeader(): Promise<string> {
  assert.ok(process.env.JWT_SECRET, "JWT_SECRET must be set before minting a dashboard cookie");
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

/** A request whose real peer is a public address: no loopback/LAN socket, public host. */
function remoteCtx(headers: Headers, method: string, pathname: string) {
  return {
    request: {
      method,
      headers,
      url: `https://dashboard.example${pathname}`,
      nextUrl: { hostname: "dashboard.example", pathname },
    },
    classification: {
      routeClass: "MANAGEMENT" as const,
      reason: "management_api" as const,
      normalizedPath: pathname,
    },
    requestId: "req_remote_readonly_test",
  };
}

async function withLoginRequired() {
  process.env.JWT_SECRET = "test-jwt-secret-for-remote-readonly";
  process.env.INITIAL_PASSWORD = "initial-pass";
  await settingsDb.updateSettings({ requireLogin: true });
}

// ── GET /api/resilience/connections: default manage-scope bypass ────────────

test("resilience connections: stays in the local-only tier for every method", () => {
  for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
    assert.equal(routeGuard.isLocalOnlyPath(RESILIENCE, method), true, method);
  }
  assert.equal(routeGuard.isLocalOnlyPath(RESILIENCE), true);
});

test("resilience connections: is not spawn-capable, so it is eligible for the bypass", () => {
  assert.equal(SPAWN_CAPABLE_PREFIXES.includes(RESILIENCE), false);
});

test("resilience connections: is in the default bypass list in all three places that define it", async () => {
  const compileTime = [...routeGuard.LOCAL_ONLY_MANAGE_SCOPE_BYPASS_PREFIXES];
  const runtimeDefault = [...runtime.getAuthzBypassSnapshot().prefixes];
  const settings = (await settingsDb.getSettings()) as Record<string, unknown>;
  const storedDefault = settings.localOnlyManageScopeBypassPrefixes;

  assert.deepEqual(compileTime, [RESILIENCE]);
  assert.deepEqual(runtimeDefault, compileTime, "runtime default snapshot drifted");
  assert.deepEqual(storedDefault, compileTime, "settings default drifted");
});

test("resilience connections: bypassable by default, and the kill-switch still turns it off", async () => {
  assert.equal(routeGuard.isLocalOnlyBypassableByManageScope(RESILIENCE), true);

  await runtime.applyRuntimeSettings({ localOnlyManageScopeBypassEnabled: false });
  assert.equal(routeGuard.isLocalOnlyBypassableByManageScope(RESILIENCE), false);
});

test("resilience connections: an operator's stored list is respected, not overridden by the default", async () => {
  await runtime.applyRuntimeSettings({ localOnlyManageScopeBypassPrefixes: ["/api/mcp/"] });
  assert.equal(routeGuard.isLocalOnlyBypassableByManageScope(RESILIENCE), false);
});

test("resilience connections: a remote dashboard session is allowed through the bypass", async () => {
  await withLoginRequired();
  const policy = await loadPolicy();
  const cookie = await dashboardCookieHeader();
  const out = await policy.evaluate(remoteCtx(new Headers({ cookie }), "GET", RESILIENCE));
  assert.equal(out.allow, true);
  if (out.allow) assert.equal(out.subject.label, "dashboard-session-local-only-bypass");
});

test("resilience connections: an anonymous remote caller still gets 403 LOCAL_ONLY", async () => {
  await withLoginRequired();
  const policy = await loadPolicy();
  const out = await policy.evaluate(remoteCtx(new Headers(), "GET", RESILIENCE));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 403);
    assert.equal(out.code, "LOCAL_ONLY");
  }
});

test("resilience connections: an anonymous remote caller is refused even with login disabled", async () => {
  process.env.JWT_SECRET = "test-jwt-secret-for-remote-readonly";
  process.env.INITIAL_PASSWORD = "initial-pass";
  await settingsDb.updateSettings({ requireLogin: false });
  const policy = await loadPolicy();
  const out = await policy.evaluate(remoteCtx(new Headers(), "GET", RESILIENCE));
  assert.equal(out.allow, false);
  if (!out.allow) {
    assert.equal(out.status, 403);
    assert.equal(out.code, "LOCAL_ONLY");
  }
});
