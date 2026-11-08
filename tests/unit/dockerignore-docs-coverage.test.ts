/**
 * Regression guard for the Docker image documentation bundle.
 *
 * The runtime reads two files under `docs/`: `docs/openapi.yaml`
 * (/api/openapi/spec) and `docs/guides/CODEX-CLI-CONFIGURATION.md`
 * (/api/docs/codex-cli). This test parses `.dockerignore` with Docker's rule
 * semantics (tests/helpers/dockerignore.ts) and asserts both stay in the
 * Docker build context while the translated mirrors stay out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDockerIgnored, parseDockerignore } from "../helpers/dockerignore.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DOCKERIGNORE = path.resolve(REPO_ROOT, ".dockerignore");

const RUNTIME_DOCS = ["docs/openapi.yaml", "docs/guides/CODEX-CLI-CONFIGURATION.md"];

test("container builds exclude local environment files at every directory depth", () => {
  const parsed = parseDockerignore(fs.readFileSync(DOCKERIGNORE, "utf8"));
  for (const file of [
    ".env",
    ".env.production",
    ".env.development",
    ".env.local",
    "contrib/vps/.env",
    "src/.env.production.local",
  ])
    assert.equal(isDockerIgnored(file, parsed), true, `${file} must not enter the build context`);
  assert.equal(isDockerIgnored(".env.example", parsed), false);
});

test(".dockerignore keeps every doc the runtime reads", () => {
  const parsed = parseDockerignore(fs.readFileSync(DOCKERIGNORE, "utf8"));
  const missing: string[] = [];
  const ignored: string[] = [];

  for (const docPath of RUNTIME_DOCS) {
    const absPath = path.resolve(REPO_ROOT, docPath);
    if (!fs.existsSync(absPath)) {
      missing.push(docPath);
      continue;
    }
    if (isDockerIgnored(docPath, parsed)) {
      ignored.push(docPath);
    }
  }

  assert.deepEqual(missing, [], `Required docs missing from repo: ${missing.join(", ")}`);
  assert.deepEqual(
    ignored,
    [],
    `Files excluded from Docker context — the runtime reads these:\n  ${ignored.join("\n  ")}`
  );
});

test(".dockerignore excludes every translated docs mirror", () => {
  const parsed = parseDockerignore(fs.readFileSync(DOCKERIGNORE, "utf8"));
  for (const heavy of [
    "docs/i18n/pt-BR/CHANGELOG.md",
    "docs/i18n/pt-BR/README.md",
    "docs/i18n/pt-BR/AGENTS.md",
    "docs/i18n/pt-BR/llm.txt",
    "docs/i18n/pt-BR/docs/routing/AUTO-COMBO.md",
  ]) {
    assert.ok(
      isDockerIgnored(heavy, parsed),
      `${heavy} should be excluded from Docker context but is not — image size will balloon`
    );
  }
});
