/**
 * `anthropic-beta` tokens are a vocabulary, not free text: an unknown token is
 * rejected upstream, and a plausible-looking invention ("per-turn-controll-…")
 * only shows up as a 400 in production. This pins the vocabulary of the files
 * that emit it.
 *
 * Sources are split on purpose:
 *  - VERIFIED_IN_BINARY: present in the published @anthropic-ai/claude-code
 *    binary for the pinned version (extracted token list of 2.1.332). These are
 *    what a real client actually sends.
 *  - DOCUMENTED_API_ONLY: real Anthropic betas that this CLI build never emits.
 *    They gate body fields that can arrive through the passthrough, so they are
 *    forwarded when a client asks, and each needs its own written source.
 *
 * Bumping CLAUDE_CODE_CLIENT_VERSION means re-extracting the binary and moving
 * whatever it adds into the verified list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TOKEN_RE = /\b[a-z][a-z0-9-]{2,40}-20\d\d-\d\d-\d\d\b/g;

const VERIFIED_IN_BINARY = new Set([
  "advanced-tool-use-2025-11-20",
  "advisor-tool-2026-03-01",
  "afk-mode-2026-01-31",
  "cache-diagnosis-2026-04-07",
  "context-1m-2025-08-07",
  "context-management-2025-06-27",
  "dangerous-tool-use-2026-09-03",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
  "fast-mode-2026-02-01",
  "inline-tools-2026-09-15",
  "interleaved-thinking-2025-05-14",
  "message-threads-2026-08-12",
  "mid-conversation-system-2026-04-07",
  "oauth-2025-04-20",
  "per-turn-control-2026-07-01",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  "server-side-fallback-2026-06-01",
  "server-side-fallback-2026-07-01",
  "structured-outputs-2025-12-15",
  "thinking-binding-controls-2026-08-01",
  "thinking-display-updates-2026-08-18",
  "thinking-token-count-2026-05-13",
  "timing-2026-09-09",
  "tool-search-tool-2025-10-19",
]);

const DOCUMENTED_API_ONLY = new Set([
  // Public Anthropic betas; this build does not send them, clients may.
  "code-execution-2025-08-25",
  "skills-2025-10-02",
  "token-efficient-tools-2026-03-28",
  "fine-grained-tool-streaming-2025-05-14",
  // Bedrock's guide names these as aliases of the per-message effort gate.
  "mid-conversation-effort-2026-08-01",
  "per-message-effort-2026-07-01",
  // Documented gate for message-level output_config; the CLI sends the
  // per-turn-control token instead (see anthropicHeaders.ts).
  "mid-conversation-output-config-2026-07-01",
]);

const ROOT = path.join(import.meta.dirname, "..", "..");
const FILES = [
  "open-sse/executors/claudeIdentity.ts",
  "open-sse/config/anthropicHeaders.ts",
  "open-sse/services/claudeCodeCompatible.ts",
  "open-sse/services/ccBridgeTransforms.ts",
  "open-sse/executors/base.ts",
];

function tokensIn(file: string): Set<string> {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return new Set(text.match(TOKEN_RE) ?? []);
}

test("every anthropic-beta token in the claude surface is accounted for", () => {
  const unknown: string[] = [];
  for (const file of FILES) {
    for (const token of tokensIn(file)) {
      if (!VERIFIED_IN_BINARY.has(token) && !DOCUMENTED_API_ONLY.has(token)) {
        unknown.push(`${file}: ${token}`);
      }
    }
  }
  assert.deepEqual(unknown, [], "unknown beta token — verify it before adding it to the list");
});

test("no token is listed as both verified and documented-only", () => {
  for (const token of VERIFIED_IN_BINARY) {
    assert.equal(DOCUMENTED_API_ONLY.has(token), false, `${token} is in both sets`);
  }
});

test("the verified list has no dead entries once a token is retired", () => {
  const used = new Set<string>();
  for (const file of FILES) for (const token of tokensIn(file)) used.add(token);
  const dead = [...VERIFIED_IN_BINARY].filter((t) => !used.has(t));
  assert.deepEqual(dead, [], "remove retired tokens from the verified list");
});
