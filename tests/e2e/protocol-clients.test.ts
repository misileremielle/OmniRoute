import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE_URL = process.env.OMNIROUTE_BASE_URL || "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY || "";
const REQUEST_TIMEOUT_MS = Number(process.env.ECOSYSTEM_REQUEST_TIMEOUT_MS || 30000);
const TEST_TIMEOUT_MS = Number(process.env.ECOSYSTEM_TEST_TIMEOUT_MS || 60000);

function headers(extra?: Record<string, string>) {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...(extra || {}),
  };
}

async function apiFetch(path: string, options?: RequestInit) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options?.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

describe("Protocol clients E2E", () => {
  it(
    "connects via MCP stdio and invokes required tools",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "open-sse/mcp-server/server.ts"],
        env: {
          ...process.env,
          OMNIROUTE_BASE_URL: BASE_URL,
          OMNIROUTE_API_KEY: API_KEY,
        } as Record<string, string>,
        stderr: "pipe",
      });

      const client = new Client({ name: "protocol-e2e", version: "1.0.0" });
      await client.connect(transport);

      try {
        const listed = await client.listTools();
        const toolNames = listed.tools.map((tool) => tool.name);
        expect(toolNames).toContain("omniroute_get_health");
        expect(toolNames).toContain("omniroute_list_combos");

        const healthResult = await client.callTool({
          name: "omniroute_get_health",
          arguments: {},
        });
        expect(Array.isArray(healthResult.content)).toBe(true);

        const combosResult = await client.callTool({
          name: "omniroute_list_combos",
          arguments: { includeMetrics: false },
        });
        expect(Array.isArray(combosResult.content)).toBe(true);
      } finally {
        await client.close();
      }

      const auditRes = await apiFetch("/api/mcp/audit?limit=50&tool=omniroute_get_health");
      // 403 = authenticated but the key lacks the manage scope — a valid
      // authorization outcome for the management-plane audit endpoint
      // (requireManagementAuth.ts returns 403 for scope-denied valid keys).
      expect([200, 401, 403]).toContain(auditRes.status);
      if (auditRes.status === 200) {
        expect(auditRes.ok).toBe(true);
        const auditJson = (await auditRes.json()) as any;
        const entries = Array.isArray(auditJson?.entries) ? auditJson.entries : [];
        expect(entries.some((entry: any) => entry.toolName === "omniroute_get_health")).toBe(true);
      }
    },
    TEST_TIMEOUT_MS * 2
  );
});
