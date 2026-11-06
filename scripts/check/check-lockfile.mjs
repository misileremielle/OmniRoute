#!/usr/bin/env node
// scripts/check/check-lockfile.mjs
// Gate de política de lockfile (CLAUDE.md — extensão Hard Rule #1).
//
// Objetivo: detectar supply-chain poisoning no pnpm-lock.yaml antes que código
// malicioso entre no repo. Verifica:
//   integrity              → todo pacote do registry deve ter hash sha512
//   tarball                → URL explícita deve ser HTTPS e de um host permitido
//   pnpm install --frozen-lockfile --lockfile-only → lockfile satisfaz cada workspace
//
// Complementa check-deps (Fase 2 / allowlist de nomes): aquele garante que só
// nomes aprovados entram; este garante que os pacotes instalados vieram do registry
// legítimo com integridade verificável.
//
// Referência: PLANO-QUALITY-GATES-FASE7.md, Task 7.7.

import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readPnpmLock } from "../ci/pnpmLock.mjs";

const ROOT = process.cwd();

/**
 * Returns the canonical lockfile policy used by this gate. Exporting this object makes
 * the policy auditable and unit-testable without spawning a child process.
 *
 * @returns {{ lockfilePath: string, allowedHosts: string[] }}
 */
export function getLockfilePolicy() {
  return {
    lockfilePath: path.join(ROOT, "pnpm-lock.yaml"),
    // Only the official npm registry is permitted. If the project ever adopts a
    // scoped/private registry, add its hostname here and document the justification.
    allowedHosts: ["registry.npmjs.org"],
  };
}

/**
 * Validates every `packages` entry against the policy. lockfile-lint only reads npm and
 * yarn lockfiles, so the same three checks run here.
 *
 * @param {{ packages?: Record<string, { resolution?: Record<string, string> }> }} lock
 * @param {{ allowedHosts: string[] }} policy
 * @returns {string[]} one message per violation
 */
export function findLockfileViolations(lock, policy) {
  const violations = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const resolution = entry?.resolution ?? {};
    if (!resolution.integrity?.startsWith("sha512-")) {
      violations.push(`${key}: missing sha512 integrity hash`);
    }
    if (resolution.tarball) {
      let url;
      try {
        url = new URL(resolution.tarball);
      } catch {
        violations.push(`${key}: invalid tarball URL`);
        continue;
      }
      if (url.protocol !== "https:") violations.push(`${key}: tarball is not HTTPS`);
      if (!policy.allowedHosts.includes(url.hostname)) {
        violations.push(`${key}: tarball host ${url.hostname} is not allowed`);
      }
    }
  }
  return violations;
}

/**
 * Returns the cross-platform pnpm command that verifies each workspace manifest against
 * pnpm-lock.yaml, independent of the installed tree.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {string | undefined} [comSpec]
 * @returns {{ command: string, args: string[] }}
 */
export function getWorkspaceDependencyCheckCommand(
  platform = process.platform,
  comSpec = process.env.ComSpec
) {
  const pnpmArgs = ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"];
  if (platform === "win32") {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...pnpmArgs],
    };
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
  };
}

/**
 * Executes the workspace dependency consistency check while keeping the process
 * boundary injectable for deterministic success and failure tests.
 *
 * @param {{
 *   platform?: NodeJS.Platform,
 *   comSpec?: string,
 *   execFile?: typeof execFileSync,
 * }} [options]
 * @returns {{ ok: true } | { ok: false, stdout: string, stderr: string }}
 */
export function runWorkspaceDependencyCheck(options = {}) {
  const {
    platform = process.platform,
    comSpec = process.env.ComSpec,
    execFile = execFileSync,
  } = options;
  const workspaceCheck = getWorkspaceDependencyCheckCommand(platform, comSpec);

  try {
    execFile(workspaceCheck.command, workspaceCheck.args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function main() {
  const policy = getLockfilePolicy();

  if (!fs.existsSync(policy.lockfilePath)) {
    console.error(
      `[check-lockfile] FAIL — lockfile not found: ${policy.lockfilePath}\n` +
        "  → Run `pnpm install` to generate pnpm-lock.yaml"
    );
    process.exit(1);
  }

  const violations = findLockfileViolations(readPnpmLock(ROOT), policy);
  if (violations.length > 0) {
    console.error("[check-lockfile] FAIL — lockfile policy violations:");
    for (const violation of violations) console.error(`  • ${violation}`);
    console.error(
      "\n  If a scoped/private registry is intentionally used, add its hostname\n" +
        "  to getLockfilePolicy().allowedHosts in scripts/check/check-lockfile.mjs"
    );
    process.exit(1);
  }
  console.log("[check-lockfile] OK — every package has sha512 integrity from an allowed host");

  const workspaceResult = runWorkspaceDependencyCheck();
  if (workspaceResult.ok) {
    console.log("[check-lockfile] OK — workspace lock entries match their manifests");
  } else {
    console.error("[check-lockfile] FAIL — workspace lock entries are inconsistent:");
    if (workspaceResult.stdout) console.error(workspaceResult.stdout);
    if (workspaceResult.stderr) console.error(workspaceResult.stderr);
    console.error(
      "\n  → Regenerate the affected lock entries and verify with a clean `pnpm install --frozen-lockfile`"
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
