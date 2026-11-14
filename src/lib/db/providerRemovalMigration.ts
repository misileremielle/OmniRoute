/**
 * Data cleanup for `NNN_remove_<name>_providers.sql` migrations.
 *
 * Those migration files only list the removed provider ids and aliases:
 *
 *   INSERT INTO _provider_removal_ids (id) VALUES ('provider-a'), ('alias-a');
 *
 * The runner creates the temp table, executes the file, then calls
 * `applyProviderRemoval()`, which:
 *
 *   - deletes the providers' connections (their stored credentials go with them) and the
 *     per-connection runtime rows that only describe a live connection;
 *   - deletes provider-keyed configuration (registered keys, key limits, discovery results,
 *     model overrides and aliases, synced model lists, quota caches);
 *   - removes the deleted connection ids from every API key's `allowed_connections` and
 *     `preferred_connections`;
 *   - disables (`is_active = 0`) every API key whose `allowed_connections` list becomes empty,
 *     because an empty list means "no restriction" in the policy layer.
 *
 * Historical usage, call-log and quota-snapshot rows are kept. Every statement is guarded by a
 * table/column check, so the cleanup also runs on databases that never created a table.
 */
import type { SqliteAdapter } from "./adapters/types";

export const PROVIDER_REMOVAL_IDS_TABLE = "_provider_removal_ids";

/** Tables whose rows describe a live connection and are meaningless once it is gone. */
const CONNECTION_STATE_TABLES = [
  "exclusive_connection_leases",
  "session_account_affinity",
  "connection_runtime_state",
  "provider_quota_state",
  "quota_pool_connections",
  "auto_candidate_overrides",
  "provider_plans",
] as const;

/** Provider-keyed configuration: `[table, providerColumn]`. */
const PROVIDER_CONFIG_TABLES = [
  ["registered_keys", "provider"],
  ["provider_key_limits", "provider"],
  ["discovery_results", "provider_id"],
  ["model_context_overrides", "provider"],
  ["model_capability_overrides", "provider"],
] as const;

/** key_value namespaces whose key is the provider id. */
const PROVIDER_KEYED_NAMESPACES = ["customModels", "modelCompatOverrides", "providerAliases"];

/** True for migration names this module handles. */
export function isProviderRemovalMigration(name: string): boolean {
  return /^remove_[a-z0-9_]+_providers$/.test(name);
}

function hasTable(db: SqliteAdapter, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function hasColumn(db: SqliteAdapter, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

/** Create the temp table the migration file fills. Call before executing the file. */
export function prepareProviderRemoval(db: SqliteAdapter): void {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS ${PROVIDER_REMOVAL_IDS_TABLE} (id TEXT PRIMARY KEY);` +
      `DELETE FROM ${PROVIDER_REMOVAL_IDS_TABLE};`
  );
}

function stripConnectionIds(db: SqliteAdapter, column: string, disableWhenEmpty: boolean): void {
  if (!hasColumn(db, "api_keys", column)) return;
  const touchesRemoved = `
    json_valid(api_keys.${column}) AND json_type(api_keys.${column}) = 'array'
    AND EXISTS (
      SELECT 1 FROM json_each(api_keys.${column}) j
      WHERE j.value IN (SELECT id FROM temp._removed_connection_ids)
    )`;
  const remaining = `(
    SELECT json_group_array(j.value) FROM json_each(api_keys.${column}) j
    WHERE j.value NOT IN (SELECT id FROM temp._removed_connection_ids)
  )`;
  if (disableWhenEmpty && hasColumn(db, "api_keys", "is_active")) {
    // SQLite evaluates every SET expression against the old row, so both read the old list.
    db.exec(`
      UPDATE api_keys
      SET is_active = CASE
            WHEN (
              SELECT count(*) FROM json_each(api_keys.${column}) j
              WHERE j.value NOT IN (SELECT id FROM temp._removed_connection_ids)
            ) = 0 THEN 0
            ELSE is_active
          END,
          ${column} = ${remaining}
      WHERE ${touchesRemoved};
    `);
    return;
  }
  db.exec(`UPDATE api_keys SET ${column} = ${remaining} WHERE ${touchesRemoved};`);
}

/** Apply the cleanup for the ids the migration file inserted. */
export function applyProviderRemoval(db: SqliteAdapter): void {
  const ids = (
    db.prepare(`SELECT id FROM temp.${PROVIDER_REMOVAL_IDS_TABLE}`).all() as Array<{ id: string }>
  ).map((row) => row.id.trim().toLowerCase());
  if (ids.length === 0) return;

  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS _removed_connection_ids (id TEXT PRIMARY KEY);" +
      "DELETE FROM temp._removed_connection_ids;"
  );
  if (hasTable(db, "provider_connections")) {
    db.exec(`
      INSERT OR IGNORE INTO temp._removed_connection_ids (id)
      SELECT id FROM provider_connections
      WHERE lower(trim(provider)) IN (SELECT id FROM temp.${PROVIDER_REMOVAL_IDS_TABLE});
    `);
  }

  stripConnectionIds(db, "allowed_connections", true);
  stripConnectionIds(db, "preferred_connections", false);

  for (const table of CONNECTION_STATE_TABLES) {
    if (!hasColumn(db, table, "connection_id")) continue;
    db.exec(
      `DELETE FROM ${table} WHERE connection_id IN (SELECT id FROM temp._removed_connection_ids);`
    );
  }
  if (hasTable(db, "key_value")) {
    db.exec(`
      DELETE FROM key_value
      WHERE namespace = 'providerLimitsCache'
        AND key IN (SELECT id FROM temp._removed_connection_ids);
    `);
  }

  if (hasTable(db, "provider_connections")) {
    db.exec(
      "DELETE FROM provider_connections WHERE id IN (SELECT id FROM temp._removed_connection_ids);"
    );
  }

  for (const [table, column] of PROVIDER_CONFIG_TABLES) {
    if (!hasColumn(db, table, column)) continue;
    db.exec(
      `DELETE FROM ${table} WHERE lower(${column}) IN (SELECT id FROM temp.${PROVIDER_REMOVAL_IDS_TABLE});`
    );
  }
  if (hasTable(db, "key_value")) {
    const namespaces = PROVIDER_KEYED_NAMESPACES.map((n) => `'${n}'`).join(", ");
    db.exec(`
      DELETE FROM key_value
      WHERE namespace IN (${namespaces})
        AND lower(key) IN (SELECT id FROM temp.${PROVIDER_REMOVAL_IDS_TABLE});
      DELETE FROM key_value
      WHERE namespace = 'syncedAvailableModels'
        AND EXISTS (
          SELECT 1 FROM temp.${PROVIDER_REMOVAL_IDS_TABLE} r
          WHERE substr(lower(key), 1, length(r.id) + 1) = r.id || ':'
        );
    `);
  }

  db.exec(
    `DROP TABLE IF EXISTS temp._removed_connection_ids; DROP TABLE IF EXISTS temp.${PROVIDER_REMOVAL_IDS_TABLE};`
  );
}
