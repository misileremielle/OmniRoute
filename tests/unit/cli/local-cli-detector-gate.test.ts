import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectLocalCliProvider,
  findExecutable,
} from "../../../bin/cli/utils/localCliAvailability.mjs";

test("default detector: zcode/auggie absent with an empty PATH, present when on PATH", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-gate-home-"));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-gate-bin-"));
  try {
    const platform = process.platform;
    const empty = { env: { PATH: "" }, homedir: home, platform };
    assert.equal(detectLocalCliProvider("zcode", empty).available, false);
    assert.equal(detectLocalCliProvider("auggie", empty).available, false);
    // No host check exists yet for these two: fail closed.
    assert.equal(detectLocalCliProvider("devin-cli-agentic", empty).available, false);
    assert.equal(detectLocalCliProvider("codex-app-server", empty).available, false);

    const ext = platform === "win32" ? ".cmd" : "";
    await fs.writeFile(path.join(binDir, `zcode${ext}`), "");
    const withBin = {
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
      homedir: home,
      platform,
    };
    assert.equal(detectLocalCliProvider("zcode", withBin).available, true);
    assert.equal(detectLocalCliProvider("auggie", withBin).available, false);
    assert.ok(findExecutable("zcode", withBin));
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
