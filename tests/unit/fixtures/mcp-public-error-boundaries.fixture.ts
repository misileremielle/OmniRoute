import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mcp-error-boundaries-"));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const originalDataDir = process.env.DATA_DIR;
const originalPluginsDir = process.env.OMNIROUTE_PLUGINS_DIR;
const originalApiKey = process.env.OMNIROUTE_API_KEY;
const originalApiKeyId = process.env.OMNIROUTE_API_KEY_ID;
const originalInternalToken = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
const originalInternalTokenFile = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN_FILE;
const originalBaseUrl = process.env.OMNIROUTE_BASE_URL;
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.OMNIROUTE_PLUGINS_DIR = path.join(testRoot, "plugins");
process.env.OMNIROUTE_API_KEY = "mcp-boundary-test-key";
process.env.OMNIROUTE_API_KEY_ID = "mcp-boundary-test-key-id";
process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = "mcp-boundary-internal-test-token";
process.env.OMNIROUTE_BASE_URL = "http://localhost:20128";
delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN_FILE;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.OMNIROUTE_PLUGINS_DIR, { recursive: true });

const { createMcpServer } = await import("../../../open-sse/mcp-server/server.ts");
const { closeAuditDb, queryAuditEntries } = await import("../../../open-sse/mcp-server/audit.ts");
const { obsidianTools: _obsidianTools } =
  await import("../../../open-sse/mcp-server/tools/obsidianTools.ts");
const core = await import("../../../src/lib/db/core.ts");

type McpResult = {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: unknown, extra?: unknown) => Promise<McpResult>;
};

function getRegisteredHandler(server: unknown, toolName: string): RegisteredTool["handler"] {
  const registry = (server as { _registeredTools?: Record<string, RegisteredTool> })
    ._registeredTools;
  assert.ok(registry, "McpServer should expose _registeredTools");
  const tool = registry[toolName];
  assert.ok(tool, `${toolName} must be registered`);
  return tool.handler;
}

test.after(() => {
  closeAuditDb();
  core.resetDbInstance();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPluginsDir === undefined) delete process.env.OMNIROUTE_PLUGINS_DIR;
  else process.env.OMNIROUTE_PLUGINS_DIR = originalPluginsDir;
  if (originalApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = originalApiKey;
  if (originalApiKeyId === undefined) delete process.env.OMNIROUTE_API_KEY_ID;
  else process.env.OMNIROUTE_API_KEY_ID = originalApiKeyId;
  if (originalInternalToken === undefined) delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  else process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = originalInternalToken;
  if (originalInternalTokenFile === undefined) {
    delete process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN_FILE;
  } else {
    process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN_FILE = originalInternalTokenFile;
  }
  if (originalBaseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
  else process.env.OMNIROUTE_BASE_URL = originalBaseUrl;
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("core MCP handlers sanitize upstream bodies before public and audit boundaries", async () => {
  const hostile = "Bearer mcp-fetch-boundary-secret at /srv/private/mcp-fetch-boundary.ts:9:3";
  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  globalThis.fetch = async (input) => {
    calledUrls.push(String(input));
    return new Response(hostile, { status: 500 });
  };

  try {
    const handler = getRegisteredHandler(createMcpServer(), "omniroute_list_combos");
    const result = await handler({ includeMetrics: false });
    const publicText = result.content?.[0]?.text ?? "";
    assert.equal(result.isError, true);
    assert.doesNotMatch(
      publicText,
      /mcp-fetch-boundary-secret|srv\/private|mcp-fetch-boundary\.ts/i
    );
    assert.deepEqual(calledUrls, ["http://localhost:20128/api/combos"]);

    const audit = await queryAuditEntries({ tool: "omniroute_list_combos", success: false });
    assert.ok(audit.entries.length >= 1);
    assert.doesNotMatch(
      JSON.stringify(audit.entries),
      /mcp-fetch-boundary-secret|srv\/private|mcp-fetch-boundary\.ts/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every MCP public catch uses the canonical fail-closed projector", () => {
  const source = fs.readFileSync(path.join(repoRoot, "open-sse/mcp-server/server.ts"), "utf8");
  assert.doesNotMatch(source, /err instanceof Error \? err\.message : String\(err\)/);
});
