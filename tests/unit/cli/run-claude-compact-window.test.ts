import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("run claude passes the routed model's catalog window to the spawned claude", async () => {
  const { runCliTarget } = await import("../../../bin/cli/commands/run.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-run-window-"));
  const out = path.join(tmp, "seen.txt");
  await fs.mkdir(path.join(tmp, "bin"));
  await fs.writeFile(
    path.join(tmp, "bin", "claude"),
    `#!/bin/sh\nprintf '%s' "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" > '${out}'\n`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  process.env.PATH = `${path.join(tmp, "bin")}${path.delimiter}${originalPath}`;
  globalThis.fetch = (async (url: string) =>
    String(url).endsWith("/api/monitoring/health")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ data: [{ id: "glm/glm-5.2", max_input_tokens: 131072 }] }), {
          status: 200,
        })) as typeof fetch;
  try {
    const code = await runCliTarget(
      "claude",
      { remote: "http://127.0.0.1:20128", token: "t", model: "glm/glm-5.2" },
      []
    );
    assert.equal(code, 0);
    assert.equal(await fs.readFile(out, "utf8"), "111411");
  } finally {
    process.env.PATH = originalPath;
    globalThis.fetch = originalFetch;
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
