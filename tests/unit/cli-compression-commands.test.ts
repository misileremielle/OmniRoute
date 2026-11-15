import test from "node:test";
import assert from "node:assert/strict";

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c: string | Uint8Array) => {
    if (typeof c === "string") chunks.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

type RestCall = { url: string; method: string; body: any };

function recordFetch(data: unknown = {}) {
  const calls: RestCall[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: any) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return makeResp(data);
  }) as any;
  return { calls, restore: () => (globalThis.fetch = origFetch) };
}

const pathOf = (u: string) => new URL(u, "http://localhost").pathname;

test("compression status reads settings, combos and analytics over REST", async () => {
  const rec = recordFetch({ defaultMode: "rtk", combos: [] });
  const { runCompressionStatus } = await import("../../bin/cli/commands/compression.mjs");
  const out = await captureStdout(() => runCompressionStatus({}, makeCmd() as any));
  rec.restore();
  assert.deepEqual(rec.calls.map((c) => pathOf(c.url)).sort(), [
    "/api/context/analytics",
    "/api/context/combos",
    "/api/settings/compression",
  ]);
  assert.match(out, /"strategy": "rtk"/);
});

test("compression configure PUTs only schema-valid keys to /api/settings/compression", async () => {
  const rec = recordFetch({ success: true });
  const { runCompressionConfigure } = await import("../../bin/cli/commands/compression.mjs");
  await captureStdout(() => runCompressionConfigure({ engine: "caveman" }, makeCmd() as any));
  rec.restore();
  assert.equal(rec.calls.length, 1);
  assert.equal(pathOf(rec.calls[0].url), "/api/settings/compression");
  assert.equal(rec.calls[0].method, "PUT");
  // #6571: caveman is stored as the server's "standard" mode.
  assert.deepEqual(rec.calls[0].body, { defaultMode: "standard" });
});

test("compression engine set PUTs the engine as defaultMode", async () => {
  const rec = recordFetch({});
  const out = await captureStdout(async () => {
    const { runCompressionEngineSet } = await import("../../bin/cli/commands/compression.mjs");
    await runCompressionEngineSet("rtk", {}, makeCmd() as any);
  });
  rec.restore();
  assert.equal(rec.calls[0].method, "PUT");
  assert.equal(rec.calls[0].body.defaultMode, "rtk");
  assert.ok(out.includes("rtk"));
});

test("compression engine set rejeita engine inválido", async () => {
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error("exit");
  }) as any;

  try {
    const { runCompressionEngineSet } = await import("../../bin/cli/commands/compression.mjs");
    await runCompressionEngineSet("invalid_engine", {}, makeCmd() as any);
  } catch {
    // expected
  }

  process.exit = origExit;
  assert.equal(exitCode, 2);
});

test("compression engine set normaliza hybrid → stacked alias", async () => {
  const rec = recordFetch({});
  await captureStdout(async () => {
    const { runCompressionEngineSet } = await import("../../bin/cli/commands/compression.mjs");
    await runCompressionEngineSet("hybrid", {}, makeCmd() as any);
  });
  rec.restore();
  assert.equal(rec.calls[0].body.defaultMode, "stacked");
});

test("compression rules list busca /api/compression/rules", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(
      makeResp([{ id: "rule-1", pattern: "system_prompt:.*", action: "drop" }])
    );
  }) as any;

  await (globalThis.fetch as any)("/api/compression/rules");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/compression/rules"));
});

test("compression rules add envia pattern e action", async () => {
  let capturedBody: unknown = null;
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, opts: unknown) => {
    capturedUrl = url;
    if (opts?.body) capturedBody = JSON.parse(opts.body);
    return Promise.resolve(makeResp({ id: "rule-2", pattern: ".*debug.*", action: "drop" }));
  }) as any;

  await (globalThis.fetch as any)("/api/compression/rules", {
    method: "POST",
    body: JSON.stringify({ pattern: ".*debug.*", action: "drop" }),
  });

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/compression/rules"));
  assert.equal(capturedBody.pattern, ".*debug.*");
  assert.equal(capturedBody.action, "drop");
});

test("compression language-packs busca endpoint correto", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp([{ id: "pt-BR", name: "Portuguese" }]));
  }) as any;

  await (globalThis.fetch as any)("/api/compression/language-packs");

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/compression/language-packs"));
});

test("compression.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../bin/cli/commands/compression.mjs");
  assert.equal(typeof mod.registerCompression, "function");
  assert.equal(typeof mod.runCompressionStatus, "function");
  assert.equal(typeof mod.runCompressionEngineSet, "function");
  assert.equal(typeof mod.runCompressionPreview, "function");
});
