// Provider-removal migrations (NNN_remove_<name>_providers.sql) delete the removed
// providers' connections and keep API-key allowlists fail-closed.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-removal-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { ensureApiKeyFallbackColumns } =
  await import("../../../src/lib/db/apiKeyColumnFallbacks.ts");
const removal = await import("../../../src/lib/db/providerRemovalMigration.ts");

function db() {
  return core.getDbInstance();
}

function insertConnection(id: string, provider: string) {
  db()
    .prepare(
      "INSERT INTO provider_connections (id, provider, auth_type, name, api_key, created_at, updated_at) VALUES (?, ?, 'apikey', ?, 'secret', datetime('now'), datetime('now'))"
    )
    .run(id, provider, id);
}

function insertApiKey(id: string, allowed: string[] | null, preferred: string[] | null = null) {
  db()
    .prepare(
      "INSERT INTO api_keys (id, name, key, machine_id, allowed_connections, preferred_connections, is_active, created_at) VALUES (?, ?, ?, 'm', ?, ?, 1, datetime('now'))"
    )
    .run(
      id,
      id,
      `key-${id}`,
      allowed === null ? null : JSON.stringify(allowed),
      preferred === null ? null : JSON.stringify(preferred)
    );
}

function apiKey(id: string) {
  return db()
    .prepare(
      "SELECT allowed_connections, preferred_connections, is_active FROM api_keys WHERE id = ?"
    )
    .get(id) as {
    allowed_connections: string | null;
    preferred_connections: string | null;
    is_active: number;
  };
}

function runRemoval(ids: string[]) {
  removal.prepareProviderRemoval(db());
  const insert = db().prepare("INSERT INTO _provider_removal_ids (id) VALUES (?)");
  for (const id of ids) insert.run(id);
  removal.applyProviderRemoval(db());
}

beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  ensureApiKeyFallbackColumns(db());
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("only migrations named remove_<name>_providers are handled", () => {
  assert.equal(removal.isProviderRemovalMigration("remove_web_cookie_providers"), true);
  assert.equal(removal.isProviderRemovalMigration("remove_opencode_free_provider"), false);
  assert.equal(removal.isProviderRemovalMigration("retire_chatgpt_web"), false);
});

test("removed providers lose their connections; kept providers keep theirs", () => {
  insertConnection("c-removed", "gone-web");
  insertConnection("c-alias", "GW ");
  insertConnection("c-kept", "openrouter");
  runRemoval(["gone-web", "gw"]);
  const ids = (
    db().prepare("SELECT id FROM provider_connections ORDER BY id").all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  assert.deepEqual(ids, ["c-kept"]);
});

test("allowlists lose the deleted ids, and an emptied allowlist disables the key", () => {
  insertConnection("c-removed", "gone-web");
  insertConnection("c-kept", "openrouter");
  insertApiKey("k-mixed", ["c-removed", "c-kept"], ["c-removed"]);
  insertApiKey("k-only-removed", ["c-removed"]);
  insertApiKey("k-unrestricted", null);
  insertApiKey("k-other", ["c-kept"]);
  runRemoval(["gone-web"]);

  const mixed = apiKey("k-mixed");
  assert.deepEqual(JSON.parse(mixed.allowed_connections!), ["c-kept"]);
  assert.deepEqual(JSON.parse(mixed.preferred_connections!), []);
  assert.equal(mixed.is_active, 1);

  const onlyRemoved = apiKey("k-only-removed");
  assert.deepEqual(JSON.parse(onlyRemoved.allowed_connections!), []);
  assert.equal(onlyRemoved.is_active, 0, "an empty allowlist would mean unrestricted access");

  assert.equal(apiKey("k-unrestricted").allowed_connections, null);
  assert.equal(apiKey("k-unrestricted").is_active, 1);
  assert.deepEqual(JSON.parse(apiKey("k-other").allowed_connections!), ["c-kept"]);
});

test("provider-keyed config rows for removed ids are deleted", () => {
  db()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run("customModels", "gone-web", "[]");
  db()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run("syncedAvailableModels", "gone-web:conn", "[]");
  db()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run("customModels", "openrouter", "[]");
  runRemoval(["gone-web"]);
  const rows = db()
    .prepare(
      "SELECT namespace, key FROM key_value WHERE namespace IN ('customModels', 'syncedAvailableModels') ORDER BY key"
    )
    .all();
  assert.deepEqual(rows, [{ namespace: "customModels", key: "openrouter" }]);
});

test("the web-cookie removal migration lists the removed ids but not the kept Poe gateway", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/migrations/240_remove_web_cookie_providers.sql"),
    "utf8"
  );
  for (const id of ["chatgpt-web", "grok-web", "claude-web", "chatplayground", "uc"]) {
    assert.ok(sql.includes(`('${id}')`), id);
  }
  assert.equal(sql.includes("('poe')"), false);
});
