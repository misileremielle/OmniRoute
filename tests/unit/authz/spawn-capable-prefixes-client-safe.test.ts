import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SPAWN_CAPABLE_PREFIXES } from "@/shared/constants/spawnCapablePrefixes";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VALIDATION_DIR = join(ROOT, "src/shared/validation");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Returns the VALUE-import specifiers in `src` (i.e. imports that survive to the
 * runtime bundle). `import type …` is excluded — it is erased by the compiler/SWC and
 * never creates a webpack bundle edge, so it cannot leak a Node-only dep into a
 * client bundle.
 */
function valueImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  // import [type] [<clause> from] "<spec>"  — `[^"';]*?` spans multi-line clauses.
  const re = /\bimport\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) continue; // `import type …` — erased, not a runtime edge
    specs.push(m[2]);
  }
  return specs;
}

// Regression guard for the dast-smoke "Build CLI bundle" failure:
//   Module not found: Can't resolve 'dns' / 'net'  (./node_modules/ioredis/...)
// Root cause: `settingsSchemas.ts` VALUE-imported SPAWN_CAPABLE_PREFIXES from
// `@/server/authz/routeGuard`, whose server runtime (runtimeSettings → localDb →
// apiKeys → rateLimiter → ioredis) then got dragged into the client/CLI webpack bundle
// via the dashboard onboarding wizard → validation barrel chain. Validation schemas are
// client-reachable and MUST depend only on zod + `@/shared` leaves — never on the
// server (`@/server/…`) or server-side lib (`@/lib/…`, which reaches the DB/ioredis).
const FORBIDDEN_VALUE_ROOTS = ["@/server/", "@/lib/"];

test("validation schemas must not VALUE-import from server-side roots (client/CLI build safety)", () => {
  const offenders: string[] = [];
  for (const file of walkTsFiles(VALIDATION_DIR)) {
    const rel = file.slice(ROOT.length + 1);
    for (const spec of valueImportSpecifiers(readFileSync(file, "utf8"))) {
      if (FORBIDDEN_VALUE_ROOTS.some((root) => spec.startsWith(root))) {
        offenders.push(`${rel} → ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Client-reachable validation schemas VALUE-import server-side modules, which drags the " +
      "server runtime (→ ioredis) into the browser/CLI bundle and breaks the Next build with " +
      `"Can't resolve 'dns'/'net'". Move the needed value to a server-free @/shared/constants ` +
      `leaf (see src/shared/constants/spawnCapablePrefixes.ts). Offenders:\n  ${offenders.join("\n  ")}`
  );
});

test("SPAWN_CAPABLE_PREFIXES is defined in the server-free constants leaf with the expected entries", () => {
  assert.ok(Array.isArray(SPAWN_CAPABLE_PREFIXES));
  // The full deny-list survived the extraction out of routeGuard.ts (Hard Rules #15/#16).
  for (const prefix of [
    "/api/services/",
    "/api/local/",
    "/api/headroom/start",
    "/api/headroom/stop",
    "/api/vnc-session",
    // GHSA-jx89-f37j-pq89: skills handler registration + execution reach the
    // sandbox container spawn transitively.
    // The CLIProxyAPI binary lifecycle under /api/version-manager/, same work as /api/services/.
    "/api/version-manager/",
    // LOCAL_ONLY spawn / code-exec routes that were never mirrored into the deny-list
    // (drift guard: tests/unit/authz/local-only-bypass-spawn-denylist.test.ts).
    "/api/middleware/",
    "/api/system/version",
    "/api/db-backups/exportAll",
    "/api/db/health",
    "/api/oauth/cursor/auto-import",
    "/dashboard/providers/services/",
    "/api/discovery/",
    "/api/issue-agent/",
    "/api/oauth/kiro/auto-import",
  ]) {
    assert.ok(
      SPAWN_CAPABLE_PREFIXES.includes(prefix),
      `SPAWN_CAPABLE_PREFIXES lost the spawn-capable prefix "${prefix}" during extraction`
    );
  }
  // 38 entries until the CLI tool configurators were removed with their 22
  // /api/cli-tools/* routes. Earlier removals already dropped 6 tunnel routes and
  // 4 MITM / Agent Bridge / Traffic Inspector routes.
  assert.equal(SPAWN_CAPABLE_PREFIXES.length, 16);
});
