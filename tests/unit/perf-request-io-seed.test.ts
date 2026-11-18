// Addendum A1 (cold /v1/models, M10): the seed's catalog mode and its provider fixture.
// Runs with tests/_setup/isolateDataDir.ts, so DATA_DIR is a fresh temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_FAKE_KEY,
  CATALOG_TTL_MS,
  parseProviderList,
  parseSeedArgs,
  runSeed,
} from "../../scripts/perf/request-io-seed.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "perf-io", "vm-catalog-providers.txt");

test("parseSeedArgs: catalog needs --providers; unknown kinds are refused", () => {
  assert.deepEqual(parseSeedArgs(["--kind", "catalog", "--providers", "/x.txt"]), {
    kind: "catalog",
    baseUrl: null,
    providers: "/x.txt",
    help: false,
  });
  assert.throws(() => parseSeedArgs(["--kind", "catalog"]), /requires --providers/);
  assert.throws(() => parseSeedArgs(["--kind", "nope"]), /fake, openrouter or catalog/);
  assert.throws(() => parseSeedArgs(["--kind", "catalog", "--providers"]), /requires a value/);
  // Existing modes are unchanged.
  assert.equal(parseSeedArgs(["--kind", "openrouter"]).providers, null);
  assert.throws(() => parseSeedArgs(["--kind", "fake"]), /requires --base-url/);
});

test("parseProviderList: comments and blanks skipped; bad, duplicate and empty lists throw", () => {
  assert.deepEqual(parseProviderList("# c\n\nopenrouter\r\n  kilocode  \n"), [
    "openrouter",
    "kilocode",
  ]);
  assert.throws(() => parseProviderList("open router\n"), /line 1: bad id/);
  assert.throws(() => parseProviderList("a\nB\n"), /line 2: bad id/);
  assert.throws(() => parseProviderList("a\n# x\na\n"), /line 3: duplicate id "a"/);
  assert.throws(() => parseProviderList("# only a comment\n\n"), /empty/);
});

test("fixture: 29 ids, each a provider the branch registers", async () => {
  const ids = parseProviderList(readFileSync(FIXTURE, "utf8"));
  assert.equal(ids.length, 29);
  const { getRegisteredProviders } = await import("../../open-sse/config/providerRegistry.ts");
  const registered = new Set(getRegisteredProviders());
  const unknown = ids.filter((id) => !registered.has(id));
  assert.deepEqual(unknown, [], `not registered: ${unknown.join(", ")}`);
});

test("runSeed --kind catalog: login off, one fake-key connection per id, TTL read back", async () => {
  assert.ok(process.env.DATA_DIR, "isolateDataDir must set DATA_DIR");
  const dir = mkdtempSync(path.join(tmpdir(), "perf-seed-"));
  const list = path.join(dir, "providers.txt");
  writeFileSync(list, "openrouter\nkilocode\n");

  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  try {
    await runSeed(["--kind", "catalog", "--providers", list], process.env);
  } finally {
    console.log = log;
  }
  const report = JSON.parse(lines.at(-1) ?? "{}");
  assert.equal(report.status, "ok");
  assert.equal(report.kind, "catalog");
  assert.equal(report.providers, 2);
  assert.equal(report.ttlMs, CATALOG_TTL_MS);
  assert.ok(!JSON.stringify(report).includes(CATALOG_FAKE_KEY), "report must not carry the key");

  const settings = await import("../../src/lib/db/settings.ts");
  const current = (await settings.getSettings()) as Record<string, unknown>;
  assert.equal(current.requireLogin, false);
  const dbSettings = await import("../../src/lib/db/databaseSettings.ts");
  assert.equal(dbSettings.getUserDatabaseSettings().cache.modelCatalogCacheTtlMs, CATALOG_TTL_MS);
  const providers = await import("../../src/lib/db/providers.ts");
  const conns = (await providers.getProviderConnections({})) as Array<Record<string, unknown>>;
  const seeded = conns.filter((c) => String(c.name).startsWith("perf-m10-"));
  assert.deepEqual(seeded.map((c) => c.provider).sort(), ["kilocode", "openrouter"]);
  for (const c of seeded) assert.equal(c.authType, "apikey");

  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  closeDbInstance();
});

test("runSeed --kind catalog: a bad list fails before the DB is touched", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perf-seed-bad-"));
  const list = path.join(dir, "providers.txt");
  writeFileSync(list, "Bad Id\n");
  await assert.rejects(
    runSeed(["--kind", "catalog", "--providers", list], { ...process.env, DATA_DIR: dir }),
    /bad id/
  );
});
