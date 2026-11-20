// Step-11 fix 3: the log-write batch must never flush inside a transaction someone else opened,
// so every adapter reports whether its handle is in one (`inTransaction`). An adapter that cannot
// tell reports `undefined`, which the batch treats as "in a transaction".
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createNodeSqliteAdapterFromDatabase } from "../../../src/lib/db/adapters/nodeSqliteShared.ts";
import {
  createBunSqliteAdapter,
  type BunSqliteDatabaseLike,
} from "../../../src/lib/db/adapters/bunSqliteAdapter.ts";

const { createSqlJsAdapter } = await import("../../../src/lib/db/adapters/sqljsAdapter.ts");

test("node:sqlite reports outer transactions, savepoints and raw BEGIN", () => {
  const adapter = createNodeSqliteAdapterFromDatabase(new DatabaseSync(":memory:"), ":memory:");
  try {
    adapter.exec("CREATE TABLE t (v INTEGER)");
    assert.equal(adapter.inTransaction, false);

    const seen: boolean[] = [];
    adapter.transaction(() => {
      seen.push(adapter.inTransaction === true);
      adapter.transaction(() => {
        seen.push(adapter.inTransaction === true);
      })();
    })();
    adapter.immediate(() => {
      seen.push(adapter.inTransaction === true);
    });
    assert.deepEqual(seen, [true, true, true]);
    assert.equal(adapter.inTransaction, false);

    // A raw BEGIN does not go through the adapter's depth counter; SQLite's flag still sees it.
    adapter.exec("BEGIN IMMEDIATE");
    assert.equal(adapter.inTransaction, true);
    adapter.exec("COMMIT");
    assert.equal(adapter.inTransaction, false);

    assert.throws(() =>
      adapter.transaction(() => {
        throw new Error("boom");
      })()
    );
    assert.equal(adapter.inTransaction, false, "a rolled-back transaction leaves no flag");
  } finally {
    adapter.close();
  }
});

test("node:sqlite without isTransaction (Node 22) still sees a raw BEGIN, via the probe", () => {
  const real = new DatabaseSync(":memory:");
  // Same database, but without the Node 24 isTransaction flag.
  const adapter = createNodeSqliteAdapterFromDatabase(
    {
      prepare: (sql: string) => real.prepare(sql),
      exec: (sql: string) => real.exec(sql),
      close: () => real.close(),
    },
    ":memory:"
  );
  try {
    adapter.exec("CREATE TABLE t (v INTEGER)");
    assert.equal(adapter.inTransaction, false);
    assert.equal(real.isTransaction, false, "the probe leaves no transaction open");
    adapter.exec("BEGIN IMMEDIATE");
    adapter.prepare("INSERT INTO t (v) VALUES (1)").run();
    assert.equal(adapter.inTransaction, true);
    adapter.exec("COMMIT");
    assert.equal(
      (adapter.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n,
      1,
      "the probe did not roll back the caller's transaction"
    );
    assert.equal(adapter.inTransaction, false);
  } finally {
    adapter.close();
  }
});

test("a probe that fails for another reason answers 'in a transaction'", () => {
  const adapter = createNodeSqliteAdapterFromDatabase(
    {
      prepare() {
        throw new Error("not used");
      },
      exec(sql: string) {
        if (sql.startsWith("BEGIN")) throw new Error("database is locked");
      },
      close() {},
    },
    ":memory:"
  );
  assert.equal(adapter.inTransaction, true);
});

test("node:sqlite without isTransaction falls back to the adapter's own depth", () => {
  const db = {
    prepare() {
      throw new Error("not used");
    },
    exec() {},
    close() {},
  };
  const adapter = createNodeSqliteAdapterFromDatabase(db, ":memory:");
  assert.equal(adapter.inTransaction, false);
  let inside: boolean | undefined;
  adapter.transaction(() => {
    inside = adapter.inTransaction;
  })();
  assert.equal(inside, true);
  adapter.immediate(() => {
    inside = adapter.inTransaction;
  });
  assert.equal(inside, true);
  assert.equal(adapter.inTransaction, false);
});

test("sql.js reports transaction() and immediate(), and clears after a rollback", async () => {
  const adapter = await createSqlJsAdapter(":memory:");
  try {
    adapter.exec("CREATE TABLE t (v INTEGER)");
    assert.equal(adapter.inTransaction, false);
    const seen: boolean[] = [];
    adapter.transaction(() => {
      seen.push(adapter.inTransaction === true);
      adapter.transaction(() => {
        seen.push(adapter.inTransaction === true);
      })();
      seen.push(adapter.inTransaction === true);
    })();
    adapter.immediate(() => {
      seen.push(adapter.inTransaction === true);
    });
    assert.deepEqual(seen, [true, true, true, true]);
    assert.equal(adapter.inTransaction, false);
    assert.throws(() =>
      adapter.transaction(() => {
        throw new Error("boom");
      })()
    );
    assert.equal(adapter.inTransaction, false);

    // A raw BEGIN bypasses runSavepoint; the probe still sees it and leaves it intact.
    adapter.exec("BEGIN IMMEDIATE");
    adapter.prepare("INSERT INTO t (v) VALUES (1)").run();
    assert.equal(adapter.inTransaction, true);
    adapter.exec("COMMIT");
    assert.equal(adapter.inTransaction, false);
    assert.equal((adapter.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 1);
  } finally {
    adapter.close();
  }
});

function bunDouble(flag: { value?: boolean }): BunSqliteDatabaseLike {
  return {
    query() {
      throw new Error("not used");
    },
    exec() {},
    transaction<T>(fn: (...args: unknown[]) => T) {
      return (...args: unknown[]) => fn(...args);
    },
    close() {},
    get inTransaction() {
      return flag.value;
    },
  };
}

test("bun:sqlite passes the driver's flag through, undefined when the driver has none", () => {
  const flag: { value?: boolean } = { value: false };
  const adapter = createBunSqliteAdapter(bunDouble(flag), ":memory:");
  assert.equal(adapter.inTransaction, false);
  flag.value = true;
  assert.equal(adapter.inTransaction, true);
  delete flag.value;
  assert.equal(adapter.inTransaction, undefined);
});

test("bun:sqlite real driver reports transactions", async (t) => {
  if (!process.versions.bun) {
    t.skip("bun:sqlite is only available under Bun");
    return;
  }
  const { Database } = await import("bun:sqlite");
  const adapter = createBunSqliteAdapter(new Database(":memory:"), ":memory:");
  t.after(() => adapter.close());
  assert.equal(adapter.inTransaction, false);
  let inside: boolean | undefined;
  adapter.transaction(() => {
    inside = adapter.inTransaction;
  })();
  assert.equal(inside, true);
});
