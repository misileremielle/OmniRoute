/**
 * OSS-051 — the MITM management route (and the since-removed tunnel routes)
 * returned raw `error.message`. Those errors come from child processes and
 * from filesystem I/O under the operator's home directory, so the body could
 * disclose host layout, binary install paths, the OS account name and live
 * credentials. Hard Rule #12 forbids this.
 *
 * `sanitizeErrorMessage()` alone does not close it: it only rewrites tokens
 * that look like an absolute path ending in a *source* extension (SOURCE_EXT
 * in open-sse/utils/error.ts), so `.json` state paths, extension-less binary
 * paths and `tskey-*` keys all survive it verbatim. The first test below pins
 * that, so the reason `publicSafeTunnelError.ts` exists stays visible.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tunnel-sanitize-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "tunnel-sanitize-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { sanitizeErrorMessage } = await import("../../open-sse/utils/error.ts");
const { classifyTunnelError, toPublicSafeTunnelError } =
  await import("../../src/lib/api/publicSafeTunnelError.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

/** The exact leak shapes these routes produce in the field. */
const LEAKS = [
  {
    label: "config/state path (.json)",
    message:
      "ENOENT: no such file or directory, open '/home/operator/.omniroute/data/tunnels.json'",
    secrets: ["/home/operator", "tunnels.json"],
    sharedSanitizerCovers: true,
  },
  {
    label: "binary path (no extension)",
    message: "spawn /usr/local/bin/cloudflared ENOENT",
    secrets: ["/usr/local/bin/cloudflared"],
    sharedSanitizerCovers: true,
  },
  {
    label: "tailscale auth key",
    message: "tailscale up failed: invalid key tskey-auth-kMn3Qz7RtY-9fVbXsPq2LdWc",
    secrets: ["tskey-auth-kMn3Qz7RtY-9fVbXsPq2LdWc"],
    sharedSanitizerCovers: false,
  },
  {
    label: "daemon state path",
    message:
      "Command failed: /opt/omniroute/bin/tailscaled --state=/var/lib/tailscale/tailscaled.state",
    secrets: ["/opt/omniroute/bin/tailscaled", "/var/lib/tailscale"],
    sharedSanitizerCovers: true,
  },
  {
    label: "windows config path",
    message:
      "listen EADDRINUSE: address already in use 0.0.0.0:41641 (config C:\\Users\\operator\\AppData\\omniroute\\ngrok.yml)",
    secrets: ["C:\\Users\\operator", "ngrok.yml"],
    sharedSanitizerCovers: true,
  },
] as const;

/** Run `fn` with console.error captured, so the helper's log does not spam output. */
async function withSilencedConsoleError<T>(fn: () => T | Promise<T>): Promise<[T, unknown[][]]> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    return [await fn(), calls];
  } finally {
    console.error = original;
  }
}

// ── Why a dedicated module: sanitizeErrorMessage does not cover all of these ─

test("sanitizeErrorMessage covers the path shapes and still misses the auth key", () => {
  // #12506 taught the shared sanitizer to redact filesystem paths, so the four
  // path-shaped leaks below are handled upstream now — a real improvement, and
  // the reason this test no longer claims "every shape survives". The tailscale
  // auth key is not path-shaped and is still echoed verbatim, which is why the
  // routes must keep going through publicSafeTunnelError rather than trusting
  // the shared sanitizer. Flip an entry's `sharedSanitizerCovers` the day that
  // changes; never relax the public-body assertions below it.
  for (const leak of LEAKS) {
    const out = sanitizeErrorMessage(leak.message);
    const stillLeaks = leak.secrets.some((s) => out.includes(s));
    assert.equal(
      stillLeaks,
      !leak.sharedSanitizerCovers,
      `${leak.label}: shared-sanitizer coverage changed — expected ` +
        `${leak.sharedSanitizerCovers ? "covered" : "still leaking"}, got: ${out}`
    );
  }
  assert.ok(
    LEAKS.some((leak) => !leak.sharedSanitizerCovers),
    "publicSafeTunnelError would be redundant if the shared sanitizer covered every shape"
  );
});

// ── The public-safe contract ───────────────────────────────────────────────

test("toPublicSafeTunnelError never echoes the upstream message", async () => {
  for (const leak of LEAKS) {
    const [body] = await withSilencedConsoleError(() =>
      toPublicSafeTunnelError(new Error(leak.message), "Failed to update the tunnel.", "test")
    );
    assert.equal(body.error, "Failed to update the tunnel.", `${leak.label}: fallback replaced`);
    for (const secret of leak.secrets) {
      assert.ok(!body.error.includes(secret), `${leak.label}: leaked ${secret}`);
      assert.ok(
        !JSON.stringify(body).includes(secret),
        `${leak.label}: leaked ${secret} elsewhere in the body`
      );
    }
    assert.equal(typeof body.reason, "string");
  }
});

test("toPublicSafeTunnelError logs the real error server-side", async () => {
  const [, calls] = await withSilencedConsoleError(() =>
    toPublicSafeTunnelError(new Error("spawn /usr/local/bin/cloudflared ENOENT"), "nope", "ctx")
  );
  assert.equal(calls.length, 1, "operator must still get the real cause in the server log");
  assert.equal(calls[0][0], "[ctx]");
});

test("classifyTunnelError maps causes without echoing them", () => {
  assert.equal(classifyTunnelError(new Error("spawn cloudflared ENOENT")), "not_installed");
  assert.equal(classifyTunnelError(new Error("EACCES: permission denied")), "permission_denied");
  assert.equal(classifyTunnelError(new Error("listen EADDRINUSE")), "already_running");
  assert.equal(classifyTunnelError(new Error("connect ETIMEDOUT")), "timeout");
  assert.equal(classifyTunnelError(new Error("connect ECONNREFUSED")), "network");
  assert.equal(classifyTunnelError(new Error("something else entirely")), "unknown");
  assert.equal(classifyTunnelError(undefined), "unknown");
});

// ── Regression sweep over the whole surface this PR covers ────────────────

test("the MITM route does not echo a raw error.message any more", () => {
  const roots = ["src/app/api/settings/mitm"];
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      for (const [i, line] of fs.readFileSync(full, "utf8").split("\n").entries()) {
        // The comments this PR adds mention the old pattern by name; only flag code.
        if (line.trimStart().startsWith("//")) continue;
        if (/\b\w+ instanceof Error \? \w+\.message\b/.test(line)) {
          offenders.push(`${full}:${i + 1}`);
        }
      }
    }
  };

  for (const root of roots) walk(path.resolve(process.cwd(), root));
  assert.deepEqual(
    offenders,
    [],
    `Hard Rule #12: these lines put a raw error.message in a response body:\n${offenders.join("\n")}`
  );
});
