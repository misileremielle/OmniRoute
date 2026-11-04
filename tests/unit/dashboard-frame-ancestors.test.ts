// Frame-ancestors posture: every route ships `frame-ancestors 'none'` +
// `X-Frame-Options: DENY`, with the single G-10 same-origin override for the
// embedded-service proxy path.
//
// These tests assert EFFECTIVE headers, not config shape: `effectiveHeaders()` replays
// Next.js's own matching + last-wins merge (see
// node_modules/next/dist/server/lib/router-utils/resolve-routes.js, `resHeaders[key] = value`)
// so a rule that silently stops matching, or an ordering regression, fails here.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match.js";

const modulePath = path.join(process.cwd(), "next.config.mjs");

interface HeaderEntry {
  key: string;
  value: string;
}
interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

async function loadHeaders(label: string): Promise<HeaderRule[]> {
  const mod = await import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
  return mod.default.headers();
}

/** Replay Next.js's header matching + last-wins merge for one pathname. */
function effectiveHeaders(rules: HeaderRule[], pathname: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rule of rules) {
    if (getPathMatch(rule.source, { removeUnnamedParams: true })(pathname) === false) continue;
    for (const { key, value } of rule.headers) merged[key] = value;
  }
  return merged;
}

// HTML pages.
const PAGE_PATHS = [
  "/",
  "/dashboard",
  "/dashboard/providers",
  "/dashboard/combos/editor",
  "/login",
  "/forgot-password",
  "/docs/guides/i18n",
  "/landing",
  "/status",
];

// The process-spawning / proxy surfaces plus every root-level API alias declared in
// next.config.mjs `rewrites()`.
const API_PATHS = [
  "/api",
  "/api/v1/chat/completions",
  "/api/services/ninerouter/start",
  "/v1",
  "/v1/models",
  "/v1beta/models",
  "/chat/completions",
  "/responses",
  "/responses/abc/cancel",
  "/models",
  "/codex/responses",
  "/anthropic/v1/messages",
  "/openai/v1/models",
  "/metrics",
  "/debug",
  "/.env",
  "/a2a",
  "/healthz",
];

test("every route keeps frame-ancestors 'none' + X-Frame-Options: DENY everywhere", async () => {
  const rules = await loadHeaders("embed-off");

  assert.equal(
    rules[0].source,
    "/:path*",
    "the global rule must stay a plain catch-all"
  );

  for (const pathname of [...PAGE_PATHS, ...API_PATHS]) {
    const headers = effectiveHeaders(rules, pathname);
    assert.match(
      headers["Content-Security-Policy"],
      /frame-ancestors 'none'/,
      `${pathname} must keep frame-ancestors 'none'`
    );
    assert.equal(
      headers["X-Frame-Options"],
      "DENY",
      `${pathname} must keep X-Frame-Options: DENY`
    );
  }
});

test("the security headers are a single catch-all rule plus the G-10 embed override", async () => {
  const rules = await loadHeaders("embed-off-shape");
  assert.deepEqual(
    rules.map((rule) => rule.source),
    ["/:path*", "/dashboard/providers/services/:name/embed/:path*"]
  );
});
