import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-resilience-"));

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    exitCode: status < 400 ? 0 : 1,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

test("resilience status busca /api/resilience", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ breakers: [], cooldowns: [] }));
  }) as any;

  await (globalThis.fetch as any)("/api/resilience");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/resilience"));
});

test("resilience breakers busca include=breakers", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ breakers: [{ provider: "openai", state: "closed" }] }));
  }) as any;

  await (globalThis.fetch as any)("/api/resilience?include=breakers");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("include=breakers"));
});

test("resilience cooldowns busca include=cooldowns", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ cooldowns: [] }));
  }) as any;

  await (globalThis.fetch as any)("/api/resilience?include=cooldowns");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("include=cooldowns"));
});

test("resilience lockouts busca /api/resilience/model-cooldowns", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ items: [] }));
  }) as any;

  await (globalThis.fetch as any)("/api/resilience/model-cooldowns");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/resilience/model-cooldowns"));
});

test("resilience reset envia provider e body correto", async () => {
  let capturedBody: any = null;
  let capturedMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, opts: any) => {
    capturedMethod = opts?.method ?? "GET";
    if (opts?.body) capturedBody = JSON.parse(opts.body);
    return Promise.resolve(makeResp({ reset: true }));
  }) as any;

  await (globalThis.fetch as any)("/api/resilience/reset", {
    method: "POST",
    body: JSON.stringify({ provider: "openai", connectionId: "conn-1", allCooldowns: false }),
  });

  globalThis.fetch = origFetch;
  assert.equal(capturedMethod, "POST");
  assert.equal(capturedBody.provider, "openai");
  assert.equal(capturedBody.connectionId, "conn-1");
});

async function runProfileSet(name: string, status = 200) {
  const { registerResilience } = await import("../../bin/cli/commands/resilience.mjs");
  const program = new Command();
  program.name("omniroute").option("--output <fmt>", "output", "json").exitOverride();
  registerResilience(program);
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let exitCode: number | null = null;
  const origFetch = globalThis.fetch;
  const origWrite = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { status });
  }) as typeof fetch;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error(`EXIT_${code}`);
  }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "omniroute", "resilience", "profile", "set", name]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("EXIT_")) throw err;
  } finally {
    globalThis.fetch = origFetch;
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { calls, exitCode };
}

test("resilience profile set PATCHes /api/resilience with the preset", async () => {
  const { RESILIENCE_PROFILES } = await import("../../bin/cli/commands/resilience.mjs");
  const { calls, exitCode } = await runProfileSet("balanced");
  assert.equal(exitCode, null);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/api/resilience");
  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(calls[0].body, RESILIENCE_PROFILES.balanced);
});

test("resilience profile set exits 1 when the PATCH fails", async () => {
  const { exitCode } = await runProfileSet("aggressive", 400);
  assert.equal(exitCode, 1);
});

test("every resilience preset passes the server's PATCH schema", async () => {
  const { RESILIENCE_PROFILES } = await import("../../bin/cli/commands/resilience.mjs");
  const { updateResilienceSchema } =
    await import("../../src/shared/validation/schemas/settings.ts");
  for (const [name, body] of Object.entries(RESILIENCE_PROFILES)) {
    const r = updateResilienceSchema.safeParse(body);
    assert.ok(r.success, `${name}: ${r.success ? "" : r.error.message}`);
  }
});

test("resilience.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../bin/cli/commands/resilience.mjs");
  assert.equal(typeof mod.registerResilience, "function");
});
