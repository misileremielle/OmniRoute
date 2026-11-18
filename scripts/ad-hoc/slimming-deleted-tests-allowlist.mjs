#!/usr/bin/env node
// One-off: build `_deletedWithReplacement` entries for the test files deleted by the slimming
// steps (base..HEAD). For each deleted test, `sourceRemoved` lists the production files it imported
// (resolved from the test's base content) that no longer exist at HEAD. A test with no such import
// gets a second pass: the production files deleted by the same commit whose name (without
// extension, at least 5 characters) appears in the test's path or content. Tests matched by
// neither pass are printed as "unresolved" and left out, for a human to decide.
//
// Usage: node scripts/ad-hoc/slimming-deleted-tests-allowlist.mjs <base> [--write]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2];
const write = process.argv.includes("--write");
if (!base) {
  console.error("usage: slimming-deleted-tests-allowlist.mjs <base> [--write]");
  process.exit(2);
}
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const commitOf = new Map();
for (const line of git(
  "log",
  "--format=%h %s",
  "--diff-filter=D",
  "--name-only",
  `${base}..HEAD`
).split("\n")) {
  if (/^[0-9a-f]{7,} /.test(line)) commitOf.current = line;
  else if (line.trim() && !commitOf.has(line.trim())) commitOf.set(line.trim(), commitOf.current);
}

const deleted = git("diff", "--name-only", "--diff-filter=D", base, "HEAD")
  .split("\n")
  .filter((f) => TEST_RE.test(f));
const baseFiles = new Set(git("ls-tree", "-r", "--name-only", base).split("\n"));
const EXT = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

function resolveSpec(fromFile, spec) {
  let p;
  if (spec.startsWith("@/")) p = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith("@omniroute/open-sse/")) p = path.posix.join("open-sse", spec.slice(20));
  else if (spec === "@omniroute/open-sse") p = "open-sse/index";
  else if (spec.startsWith("."))
    p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else return null;
  for (const e of EXT) if (baseFiles.has(p + e)) return p + e;
  return null;
}

// Production files each commit deleted, for the second pass.
const deletedByCommit = new Map();
{
  let cur = null;
  for (const line of git(
    "log",
    "--format=%h %s",
    "--diff-filter=D",
    "--name-only",
    `${base}..HEAD`
  ).split("\n")) {
    if (/^[0-9a-f]{7,} /.test(line)) {
      cur = line;
      deletedByCommit.set(cur, []);
    } else if (
      line.trim() &&
      cur &&
      !TEST_RE.test(line) &&
      !line.startsWith("tests/") &&
      !fs.existsSync(line.trim())
    )
      deletedByCommit.get(cur).push(line.trim());
  }
}
const GENERIC = new Set([
  "index",
  "route",
  "page",
  "types",
  "utils",
  "constants",
  "schema",
  "schemas",
  "config",
  "client",
  "server",
  "layout",
  "helpers",
]);
const GENERIC_DIRS = new Set([
  "stream",
  "files",
  "content",
  "status",
  "start",
  "history",
  "translate",
  "shared",
  "config",
  "detect",
  "models",
  "health",
  "settings",
  "runtime",
]);
// A file or folder name shared by 3+ deleted files (models, stream, error...) names no feature.
const nameCount = new Map();
for (const p of [...deletedByCommit.values()].flat()) {
  for (const n of [
    path.posix
      .basename(p)
      .replace(/\.[^.]+$/, "")
      .toLowerCase(),
    "dir:" + path.posix.basename(path.posix.dirname(p)).toLowerCase(),
  ])
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
}
const distinctive = (n, isDir = false) => (nameCount.get(isDir ? "dir:" + n : n) ?? 0) < 3 || isDir;

function namedSources(f, src, step) {
  const hay = `${f}\n${src}`.toLowerCase();
  const pool =
    step === "*" ? [...deletedByCommit.values()].flat() : (deletedByCommit.get(step) ?? []);
  return pool.filter((p) => {
    const name = path.posix
      .basename(p)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    if (name.length >= 5 && !GENERIC.has(name) && distinctive(name) && hay.includes(name))
      return true;
    // route/page files are named by their folder: src/app/.../playground/page.tsx -> "playground"
    const dir = path.posix.basename(path.posix.dirname(p)).toLowerCase();
    return (
      GENERIC.has(name) &&
      dir.length >= 5 &&
      !dir.startsWith("[") &&
      !GENERIC_DIRS.has(dir) &&
      hay.includes(dir)
    );
  });
}

function filenameSources(f) {
  const parts = path.posix
    .basename(f)
    .replace(TEST_RE, "")
    .toLowerCase()
    .split("-")
    .filter((t) => !/^\d+$/.test(t));
  const ids = new Set();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length >= 4) ids.add(parts[i]);
    if (i + 1 < parts.length) ids.add(`${parts[i]}-${parts[i + 1]}`);
  }
  const skip = new Set([
    "stream",
    "error",
    "boundary",
    "labels",
    "transport",
    "redaction",
    "provider",
    "registry",
    "executor",
    "stale",
    "seed",
    "issue",
    "reasoning",
    "content",
    "echo",
    "deepseek",
    "models",
    "docs",
    "apikey",
    "settings",
    "guide",
    "payload",
    "protocol",
    "visibility",
    "fetch",
    "baseurl",
    "outbound",
    "guard",
    "input",
    "sanitizer",
    "security",
    "truthfulness",
    "null",
    "walk",
    "nonstream",
    "origin",
    "host",
  ]);
  const wanted = [...ids].filter((id) => !skip.has(id));
  return [...deletedByCommit.values()].flat().filter((p) =>
    p
      .toLowerCase()
      .split("/")
      .some((seg) => wanted.includes(seg.replace(/\.[^.]+$/, "")))
  );
}

// Matched by hand (2026-11-18) from what each test exercised; none of their imports were removed.
const MANUAL = {
  "tests/e2e/protocol-visibility.spec.ts": [
    "src/app/(dashboard)/dashboard/endpoint/components/MCPDashboard.tsx",
  ],
  "tests/integration/mcp-origin-host-e2e.test.ts": [
    "src/app/api/mcp/sse/route.ts",
    "src/app/api/mcp/stream/route.ts",
    "src/server/origin/mcpOrigin.ts",
  ],
  "tests/unit/env-docs-input-sanitizer-8093.test.ts": [
    "src/shared/utils/inputSanitizer.ts",
    "src/middleware/promptInjectionGuard.ts",
  ],
  "tests/unit/i18n-cli-namespaces.test.ts": [
    "src/app/(dashboard)/dashboard/cli-code/page.tsx",
    "src/app/(dashboard)/dashboard/cli-agents/page.tsx",
  ],
  "tests/unit/i18n-feature-flag-auto-sync-profiles-tag-12505.test.ts": [
    "src/lib/cli-helper/claudeProfileAutoSync.ts",
  ],
  "tests/unit/issue-13599-bai-deepseek-reasoning-content-echo.test.ts": [
    "open-sse/config/providers/registry/bai/index.ts",
  ],
  "tests/unit/log-payload-pii-walk-opt-in.test.ts": [
    "src/lib/guardrails/piiMasker.ts",
    "src/lib/db/piiSettings.ts",
  ],
  "tests/unit/mcp-public-error-boundaries.test.ts": [
    "open-sse/mcp-server/errorMessage.ts",
    "open-sse/mcp-server/server.ts",
  ],
  "tests/unit/mcp-sdk-external.test.ts": [
    "open-sse/mcp-server/index.ts",
    "src/app/api/mcp/stream/route.ts",
  ],
  "tests/unit/poe-provider-models-baseurl.test.ts": [
    "open-sse/config/providers/registry/poe/index.ts",
  ],
  "tests/unit/security-docs-truthfulness-8097.test.ts": [
    "src/shared/utils/inputSanitizer.ts",
    "src/lib/guardrails/promptInjection.ts",
    "src/lib/guardrails/piiMasker.ts",
  ],
};

const SPEC_RE = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;
const entries = {};
const unresolved = [];
for (const f of deleted) {
  const src = git("show", `${base}:${f}`);
  const removed = new Set();
  for (const m of src.matchAll(SPEC_RE)) {
    const r = resolveSpec(f, m[1]);
    if (!r || TEST_RE.test(r) || r.startsWith("tests/")) continue;
    if (!fs.existsSync(r)) removed.add(r);
  }
  const step = commitOf.get(f) ?? "?";
  let how = "imports";
  if (!removed.size) {
    for (const p of namedSources(f, src, step)) removed.add(p);
    how = "named";
  }
  if (!removed.size && MANUAL[f]) {
    for (const p of MANUAL[f]) if (!fs.existsSync(p)) removed.add(p);
    how = "manual";
  }
  if (!removed.size) {
    // e.g. the test-repair commit deleted tests whose providers an earlier step removed. Only names
    // taken from the test's own file name, matched against whole path segments, count here.
    for (const p of filenameSources(f)) removed.add(p);
    how = "named-any";
  }
  if (removed.size) {
    entries[f] = {
      sourceRemoved: [...removed].sort(),
      reason: `Slimming step ${step}: the feature this test covered was removed; every listed source file is gone at HEAD (${{ imports: "files the test imported", named: "files of that commit the test names", manual: "matched by hand to what the test exercised", "named-any": "files of an earlier slimming step named in the test's file name" }[how]}).`,
    };
  } else unresolved.push(`${f}  (${step})`);
}

console.log(
  `deleted tests: ${deleted.length}; with removed sources: ${Object.keys(entries).length}; unresolved: ${unresolved.length}`
);
for (const u of unresolved) console.log(`unresolved: ${u}`);

const dumpAt = process.argv.indexOf("--dump");
if (dumpAt > 0) fs.writeFileSync(process.argv[dumpAt + 1], JSON.stringify(entries, null, 2) + "\n");

if (write) {
  const file = "config/quality/test-masking-allowlist.json";
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const target = raw._deletedWithReplacement;
  let added = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (target[k]) continue;
    target[k] = v;
    added++;
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  console.log(`wrote ${added} new entries to ${file}`);
}
