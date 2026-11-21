/**
 * Asks SQLite whether the connection is inside a transaction, for drivers that expose no
 * autocommit flag (sql.js; node:sqlite before Node 24). `BEGIN` fails inside any open
 * transaction or savepoint, including a raw `BEGIN IMMEDIATE` the adapter did not open; outside
 * one it starts an empty deferred transaction, rolled back at once without writing anything.
 *
 * Any other failure answers `true`: callers use this to decide whether work may run outside a
 * transaction, so "unknown" must read as "in a transaction".
 */
export function probeOpenTransaction(run: (sql: string) => void): boolean {
  try {
    run("BEGIN DEFERRED");
  } catch {
    return true;
  }
  try {
    run("ROLLBACK");
  } catch {
    return true;
  }
  return false;
}
