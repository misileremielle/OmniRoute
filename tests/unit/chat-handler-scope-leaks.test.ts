import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The safety-net redirect rebuilds the options for each combo target and must keep the
// target's own connection scope. Structural checks, like chat-safetynet-pin.test.ts: the
// handler needs the full pipeline to run, and these are error-path branches.

const source = fs.readFileSync(new URL("../../src/sse/handlers/chat.ts", import.meta.url), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test("safety-net redirect keeps the combo target's connection pin and allow-list", () => {
  const redirect = block("Safety-net combo redirect", "isModelAvailable: async () => true");
  assert.match(redirect, /forcedConnectionId:\s*resolvedTarget\?\.connectionId/);
  assert.match(redirect, /allowedConnectionIds:\s*resolvedTarget\?\.allowedConnectionIds/);
  assert.doesNotMatch(redirect, /allowedConnectionIds:\s*null/);
});

// Fork: upstream's "throwing connection reasoning rule releases the OAuth session slot" case
// is gone with the removed reasoning routing rules (docs/ops/FORK_IDENTITY.md).
