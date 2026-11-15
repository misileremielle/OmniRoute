import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

// `oneproxy status|stats|fetch|rotate` call the free-proxy REST API directly. The legacy
// /api/settings/oneproxy routes only 308-redirect there, and apiFetch refuses redirects
// when it carries the local CLI token.

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-oneproxy-"));

type Call = { url: string; method: string; body: unknown };

function makeResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(args: string[], data: unknown, status = 200) {
  const { registerOneProxy } = await import("../../bin/cli/commands/oneproxy.mjs");
  const program = new Command();
  program.name("omniroute").option("--output <fmt>", "output", "json").exitOverride();
  registerOneProxy(program);

  const calls: Call[] = [];
  let stdout = "";
  let exitCode: number | null = null;
  const origFetch = globalThis.fetch;
  const origWrite = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: typeof raw === "string" && raw ? JSON.parse(raw) : undefined,
    });
    return makeResp(data, status);
  }) as typeof fetch;
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error(`EXIT_${code}`);
  }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "omniroute", "oneproxy", ...args]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("EXIT_")) throw err;
  } finally {
    globalThis.fetch = origFetch;
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { calls, stdout, exitCode };
}

test("oneproxy status and stats read /api/settings/free-proxies/stats", async () => {
  for (const sub of ["status", "stats"]) {
    const { calls, stdout } = await run([sub], { stats: { total: 7 } });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, "/api/settings/free-proxies/stats");
    assert.equal(calls[0].method, "GET");
    assert.match(stdout, /"total": 7/);
  }
});

test("oneproxy fetch maps --count to limit and --type to protocol", async () => {
  const { calls, stdout } = await run(["fetch", "--count", "5", "--type", "socks5"], {
    success: true,
    data: { proxies: [{ host: "10.0.0.1", type: "socks5" }], total: 1 },
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/settings/free-proxies");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("protocol"), "socks5");
  assert.match(stdout, /10\.0\.0\.1/);
});

test("oneproxy rotate posts to /api/settings/free-proxies/sync", async () => {
  const { calls } = await run(["rotate"], { synced: 3 });
  assert.equal(new URL(calls[0].url).pathname, "/api/settings/free-proxies/sync");
  assert.equal(calls[0].method, "POST");
});

test("oneproxy stats exits 1 when the API fails", async () => {
  const { exitCode } = await run(["stats"], { error: "nope" }, 500);
  assert.equal(exitCode, 1);
});
