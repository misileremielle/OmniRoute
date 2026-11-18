/**
 * #18075 — the MCP service toggle printed a hard-coded "ON"/"OFF" next to its switch.
 * #19620 — the state text is gone from both pages: the switch shows the state, and its translated
 * enable/disable name says what a press does. tests/unit/ui/mcp-a2a-service-toggle-19620.test.tsx
 * checked the rendered result. (Upstream also checks a2a/page.tsx and mcp/page.tsx; this fork
 * removed the A2A and MCP servers and their pages, so only the shared catalog check is left.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("common.on / common.off exist in the English catalog", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/messages/en.json"), "utf8"));
  assert.equal(typeof en.common.on, "string");
  assert.equal(typeof en.common.off, "string");
});
