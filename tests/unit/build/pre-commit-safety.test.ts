import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const hook = readFileSync(new URL("../../../.husky/pre-commit", import.meta.url), "utf8");

function runHook(extra: Record<string, string> = {}) {
  // Execute the checked-in hook. Only the external tools are fixtures; no real
  // stash, index mutation or dependency installation is permitted by the probe.
  const tools = `
command() { if [ "$1 $2" = "-v pnpm" ] && [ "$MOCK_PNPM_MISSING" = "1" ]; then return 1; fi; builtin command "$@"; }
pnpm() {
  if [ "$1" = "exec" ]; then printf 'PNPM_EXEC:%s\\n' "$*"; return "$MOCK_LINT_EXIT"; fi
  printf 'PNPM:%s\\n' "$*"
}
npx() { printf 'NPX:%s\\n' "$*"; }
node() { printf 'NODE:%s\\n' "$*"; }
npm() { printf 'NPM:%s\\n' "$*"; }
sh() { printf 'SH:%s\\n' "$*"; }
`;
  return spawnSync("bash", ["-c", `${tools}\n${hook}`], {
    encoding: "utf8",
    env: { ...process.env, MOCK_PNPM_MISSING: "0", MOCK_LINT_EXIT: "0", ...extra },
  });
}

test("hook never stashes and never downloads a missing lint-staged", () => {
  const result = runHook();
  assert.equal(result.status, 0, result.stderr);
  // `pnpm exec` runs only installed binaries; unlike npx or `pnpm dlx` it never downloads one.
  assert.match(result.stdout, /PNPM_EXEC:exec lint-staged --no-stash/);
  assert.doesNotMatch(result.stdout, /NPX:|PNPM:dlx/);
  assert.match(result.stdout, /NODE:scripts\/check\/check-tracked-artifacts.mjs/);
});

test("missing pnpm blocks the commit instead of silently skipping all checks", () => {
  const result = runHook({ MOCK_PNPM_MISSING: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /NODE:|PNPM/);
});

test("failed lint-staged preserves its exit even when the hook is executed directly", () => {
  const result = runHook({ MOCK_LINT_EXIT: "42" });
  assert.equal(result.status, 42);
  assert.doesNotMatch(result.stdout, /NODE:|PNPM:/);
});
