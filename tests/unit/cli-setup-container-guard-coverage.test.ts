import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Static scan, not behavior: the kept host-config writers (`config set`,
 * `configure codex`) must route through the container guard first.
 */

const COMMANDS_DIR = path.join(process.cwd(), "bin/cli/commands");
const GUARD_CALL = /guardHostConfigTarget\s*\(/;

test("config set and configure are guarded too", () => {
  for (const name of ["config.mjs", "configure.mjs"]) {
    const source = fs.readFileSync(path.join(COMMANDS_DIR, name), "utf8");
    assert.match(source, GUARD_CALL, `${name} should call the container guard`);
    assert.ok(
      source.includes("--allow-container-write"),
      `${name} should expose --allow-container-write`
    );
  }
});
