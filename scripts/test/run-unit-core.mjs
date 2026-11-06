#!/usr/bin/env node
// Fast default unit run (`pnpm run test:unit`): the request path, routing/resilience,
// translation, persistence and auth/security suites — the code most changes touch and most
// regressions break. The full suite (~7k files, one process per file) stays available as
// `pnpm run test:unit:full`, and CI keeps running it (`test:unit:ci:shard`).
//
// Selection is by path, so a new test in a core area joins automatically:
//   - every test under tests/unit/{api,auth,authz,security,combo,translator,db,correctness,
//     cors,guardrails,chatcore}/
//   - top-level tests/unit/*.test.ts whose name matches CORE_NAME below
// `--list` prints the selection instead of running it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UNIT = path.join(ROOT, "tests", "unit");

const CORE_DIRS = [
  "api",
  "auth",
  "authz",
  "security",
  "combo",
  "translator",
  "db",
  "correctness",
  "cors",
  "guardrails",
  "chatcore",
];

const CORE_NAME = new RegExp(
  "^(?:" +
    [
      "chat-core",
      "chatcore",
      "chat-route",
      "chat-handler",
      "chat-empty-stream",
      "combo-routing",
      "stream-handler",
      "stream-readiness",
      "translator-",
      "translate-request",
      "translate-response",
      "responses-transform",
      "circuit-breaker",
      "account-fallback",
      "model-lockout",
      "connection-cooldown",
      "rate-limit-manager",
      "proxy-fetch",
      "authz",
      "route-guard",
      "error-sanitiz",
      "public-creds",
      "migration-runner",
      "provider-metrics",
      "credential-health",
      "quota-preflight",
    ].join("|") +
    ")[^/]*\\.test\\.ts$",
  "i"
);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.ts"));
}

export function selectCoreTests() {
  const selected = [];
  for (const dir of CORE_DIRS) {
    for (const f of walk(path.join(UNIT, dir)))
      selected.push(path.posix.join("tests/unit", dir, f.split(path.sep).join("/")));
  }
  for (const f of fs.readdirSync(UNIT)) {
    if (CORE_NAME.test(f)) selected.push(`tests/unit/${f}`);
  }
  return [...new Set(selected)].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = selectCoreTests();
  if (process.argv.includes("--list")) {
    process.stdout.write(files.join("\n") + "\n");
    process.exit(0);
  }
  const concurrency = Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));
  console.log(
    `[test:unit] core suite: ${files.length} files, concurrency ${concurrency} (full suite: pnpm run test:unit:full)`
  );
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--import",
      "tsx/esm",
      "--import",
      "./open-sse/utils/setupPolyfill.ts",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "--test",
      "--test-force-exit",
      `--test-concurrency=${concurrency}`,
      ...process.argv.slice(2).filter((a) => a !== "--list"),
      ...files,
    ],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, DISABLE_SQLITE_AUTO_BACKUP: "true" } }
  );
  process.exit(result.status ?? 1);
}
