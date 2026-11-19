/**
 * Seed one API key into DATA_DIR for lts-baseline's TTFB phase and print it as one JSON line,
 * `{"key":"..."}`, on stdout (the last line; migrations may log before it).
 *
 *   DATA_DIR=<dir> node --import tsx/esm scripts/perf/lts-baseline-seed-key.ts
 *
 * lts-baseline runs this after its server has booted, with the server's own environment (same
 * DATA_DIR and API_KEY_SECRET), because the server gets an INITIAL_PASSWORD and /v1/models then
 * requires a credential (catalogRequest.ts getModelCatalogAuthRejection). The key is created
 * through src/lib/db/apiKeys.ts like a dashboard key, so the server checks it the normal way
 * (hash lookup, then its validation cache). It lives only in that throwaway DATA_DIR.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEED_KEY_NAME = "lts-baseline";
export const SEED_KEY_MACHINE = "lts-baseline";

export async function seedBaselineKey(): Promise<string> {
  if (!process.env.DATA_DIR) throw new Error("DATA_DIR is not set");
  const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const created = await createApiKey(SEED_KEY_NAME, SEED_KEY_MACHINE);
  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  closeDbInstance();
  if (typeof created?.key !== "string" || created.key.length === 0) {
    throw new Error("createApiKey returned no key");
  }
  return created.key;
}

const invokedAsMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  seedBaselineKey()
    .then((key) => {
      process.stdout.write(`${JSON.stringify({ key })}\n`);
    })
    .catch((error: unknown) => {
      // Fixed text only: never echo error details that could carry secrets.
      console.error(
        `[lts-baseline-seed-key] failed: ${error instanceof Error ? error.name : "error"}`
      );
      process.exit(1);
    });
}
