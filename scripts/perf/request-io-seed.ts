/**
 * Stage-2 T3 seed helper: seeds one DATA_DIR for the request-io probe, then exits.
 *
 * Runs as a short child process per DATA_DIR (before the server boots, so the
 * migrations run here): `node --import tsx/esm <root>/scripts/perf/request-io-seed.ts`,
 * with cwd = the repo root and env DATA_DIR. Mirrors the seeding order in
 * tests/integration/resilience-http-e2e.test.ts (seed, then close the DB):
 * createProviderNode + createProviderConnection via the arm's own
 * src/lib/db modules, updateSettings to mark setup complete and disable
 * retries, then closeDbInstance().
 *
 * Arguments:
 *   --kind fake --base-url <url>   openai-compatible node + apikey connection
 *   --kind openrouter              openrouter apikey connection (key from env)
 *   --kind catalog --providers <file>
 *                                  addendum A1 (cold /v1/models, M10): settings first, then
 *                                  one apikey connection with a fake key per provider id in
 *                                  <file>, then the catalog cache TTL set to CATALOG_TTL_MS
 *
 * The OpenRouter key is read from env OPENROUTER_API_KEY, never argv. Nothing
 * here prints or logs secrets.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface SeedArgs {
  kind: "fake" | "openrouter" | "catalog";
  baseUrl: string | null;
  providers: string | null;
  help: boolean;
}

export const PROBE_PREFIX = "perfio";
export const PROBE_MODEL = "perfio/test-model";
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_MODEL = "openrouter/openrouter/free";
/** Catalog cache TTL for the A1 cold-catalog run: 1 s + the 30 s stale window < the 32 s wait. */
export const CATALOG_TTL_MS = 1000;
export const CATALOG_FAKE_KEY = "perf-m10-fake-key";
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

/** Parse argv. `--kind fake` requires `--base-url`. */
export function parseSeedArgs(argv: string[]): SeedArgs {
  const out: SeedArgs = { kind: "fake", baseUrl: null, providers: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--kind": {
        const raw = requireValue(argv, i++, flag);
        if (raw !== "fake" && raw !== "openrouter" && raw !== "catalog")
          throw new Error(`--kind must be fake, openrouter or catalog`);
        out.kind = raw;
        break;
      }
      case "--base-url":
        out.baseUrl = requireValue(argv, i++, flag);
        break;
      case "--providers":
        out.providers = requireValue(argv, i++, flag);
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!out.help && out.kind === "fake" && !out.baseUrl) {
    throw new Error("--kind fake requires --base-url");
  }
  if (!out.help && out.kind === "catalog" && !out.providers) {
    throw new Error("--kind catalog requires --providers");
  }
  return out;
}

/**
 * Parse a provider list: one id per line; blank lines and `#` comments are skipped.
 * Throws on a malformed id, a duplicate, or an empty list, so a bad fixture fails the seed.
 */
export function parseProviderList(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!PROVIDER_ID_RE.test(line)) throw new Error(`providers line ${n + 1}: bad id "${line}"`);
    if (seen.has(line)) throw new Error(`providers line ${n + 1}: duplicate id "${line}"`);
    seen.add(line);
    ids.push(line);
  }
  if (ids.length === 0) throw new Error("providers list is empty");
  return ids;
}

export const SEED_USAGE = `Usage: node --import tsx/esm scripts/perf/request-io-seed.ts [--kind fake|openrouter|catalog] [--base-url <url>] [--providers <file>]

  --kind fake --base-url <url>  seed an openai-compatible node for the probe fake upstream
  --kind openrouter             seed an openrouter apikey connection (key from OPENROUTER_API_KEY env)
  --kind catalog --providers <file>
                                seed one fake-key apikey connection per provider id and a
                                ${CATALOG_TTL_MS} ms catalog cache TTL (cold /v1/models run)
  -h, --help                    show this help`;

const QUEUE_SETTING_KEYS = [
  "autoEnableApiKeyProviders",
  "requestsPerMinute",
  "minTimeBetweenRequestsMs",
  "concurrentRequests",
  "globalConcurrentRequests",
  "maxWaitMs",
  "executionMaxWaitMs",
  "maxQueueDepth",
] as const;

/**
 * Default request-queue settings for api-key providers do not delay a burst
 * of sequential probe requests: with requestsPerMinute 60 and
 * minTimeBetweenRequestsMs 350 the limiter paces at most one gap of 350 ms
 * between back-to-back requests. Still, a concurrent burst of 50 against the
 * default concurrentRequests 6 would queue behind the limiter, so the seed
 * raises the queue to { requestsPerMinute: 3600, minTimeBetweenRequestsMs: 0,
 * concurrentRequests: 50, maxWaitMs: 120000 } whenever the resolved defaults
 * are tighter. The raised values are reported in the probe report header so
 * the measurement environment stays explicit.
 */
export function queueNeedsRaising(current: Record<string, unknown> | null | undefined): boolean {
  if (!current || typeof current !== "object") return true;
  const want: Record<string, number> = {
    requestsPerMinute: 3600,
    minTimeBetweenRequestsMs: 0,
    concurrentRequests: 50,
  };
  for (const [key, minimum] of Object.entries(want)) {
    const value = current[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return true;
    if (key === "minTimeBetweenRequestsMs" ? value > minimum : value < minimum) return true;
  }
  return false;
}

/** Keep only known queue keys; unknown keys are declined, not crashed on. */
export function pickQueueSettings(source: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of QUEUE_SETTING_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

async function seedFake(baseUrl: string): Promise<{ model: string }> {
  const providers = await import("../../src/lib/db/providers.ts");
  const providerId = "openai-compatible-chat-perfio";
  await providers.createProviderNode({
    id: providerId,
    type: "openai-compatible",
    name: "Perf probe fake",
    prefix: PROBE_PREFIX,
    apiType: "chat",
    baseUrl,
  });
  await providers.createProviderConnection({
    provider: providerId,
    authType: "apikey",
    name: `conn-${PROBE_PREFIX}`,
    apiKey: "perf-probe-fake-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl, apiType: "chat" },
  });
  return { model: PROBE_MODEL };
}

async function seedOpenRouter(): Promise<{ model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const providers = await import("../../src/lib/db/providers.ts");
  await providers.createProviderConnection({
    provider: OPENROUTER_PROVIDER_ID,
    authType: "apikey",
    name: "perf-probe-openrouter",
    apiKey,
    isActive: true,
    testStatus: "active",
  });
  return { model: OPENROUTER_MODEL };
}

/**
 * A1 cold-catalog seed: one apikey connection with a fake key per provider id, then the model
 * catalog cache TTL. The TTL is read back so a clamped or ignored value fails the seed instead
 * of silently turning every M10 sample warm.
 */
export async function seedCatalog(ids: string[]): Promise<{ providers: number; ttlMs: number }> {
  const providers = await import("../../src/lib/db/providers.ts");
  for (const id of ids) {
    await providers.createProviderConnection({
      provider: id,
      authType: "apikey",
      name: `perf-m10-${id}`,
      apiKey: CATALOG_FAKE_KEY,
      isActive: true,
      testStatus: "active",
    });
  }
  const dbSettings = await import("../../src/lib/db/databaseSettings.ts");
  dbSettings.updateDatabaseSettings({
    cache: { modelCatalogCacheTtlMs: CATALOG_TTL_MS },
  } as Parameters<typeof dbSettings.updateDatabaseSettings>[0]);
  const ttlMs = dbSettings.getUserDatabaseSettings().cache?.modelCatalogCacheTtlMs;
  if (ttlMs !== CATALOG_TTL_MS) {
    throw new Error(`catalog TTL reads back as ${String(ttlMs)}, not ${CATALOG_TTL_MS}`);
  }
  return { providers: ids.length, ttlMs };
}

/** Seed settings: setup complete, no login wall, no retries. Returns the report header. */
export async function seedSettings(): Promise<{ queueRaised: boolean }> {
  const settings = await import("../../src/lib/db/settings.ts");
  // Read failures are not swallowed: a seed that cannot read settings fails.
  const current = (await settings.getSettings()) as Record<string, unknown>;
  const resilience = (current.resilienceSettings ?? {}) as Record<string, unknown>;
  // Judge the queue the server will actually use: stored values merged with defaults.
  const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
  const queue = resolveResilienceSettings(current).requestQueue as unknown as Record<
    string,
    unknown
  >;
  const queueRaised = queueNeedsRaising(queue);
  // Merge into the existing settings so nothing else in resilienceSettings changes.
  const resilienceSettings: Record<string, unknown> = queueRaised
    ? {
        ...resilience,
        requestQueue: {
          ...queue,
          requestsPerMinute: 3600,
          minTimeBetweenRequestsMs: 0,
          concurrentRequests: 50,
          maxWaitMs: 120000,
        },
      }
    : {};
  await settings.updateSettings({
    requireLogin: false,
    setupComplete: true,
    requestRetry: 0,
    maxRetryIntervalSec: 0,
    ...(Object.keys(resilienceSettings).length ? { resilienceSettings } : {}),
  });
  return { queueRaised };
}

export async function runSeed(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseSeedArgs(argv);
  if (args.help) {
    console.log(SEED_USAGE);
    return;
  }
  if (!env.DATA_DIR) throw new Error("DATA_DIR is not set");
  if (args.kind === "catalog") {
    // Read the list before touching the DB, so a bad fixture leaves no half-seeded folder.
    const ids = parseProviderList(readFileSync(args.providers as string, "utf8"));
    const { queueRaised } = await seedSettings();
    const catalog = await seedCatalog(ids);
    const { closeDbInstance } = await import("../../src/lib/db/core.ts");
    closeDbInstance();
    console.log(JSON.stringify({ status: "ok", kind: args.kind, ...catalog, queueRaised }));
    return;
  }
  const seeded =
    args.kind === "fake" ? await seedFake(args.baseUrl as string) : await seedOpenRouter();
  const { queueRaised } = await seedSettings();
  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  closeDbInstance();
  console.log(JSON.stringify({ status: "ok", kind: args.kind, model: seeded.model, queueRaised }));
}

const invokedAsMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  runSeed(process.argv.slice(2), process.env).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // The key never reaches an Error message here (it is only passed to the DB module).
    console.error(JSON.stringify({ status: "failed", reason: message }));
    process.exit(1);
  });
}
