import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeEnv, resolveLaunchTarget } from "../../../bin/cli/commands/launch.mjs";

// ── launch env (Claude Code) ─────────────────────────────────────────────────

test("buildClaudeEnv still accepts a bare port (backward compatible)", () => {
  const env = buildClaudeEnv({ PATH: "/bin" }, 20128, "secret");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:20128");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "secret");
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
});

test("buildClaudeEnv accepts a full base URL and strips /v1", () => {
  const env = buildClaudeEnv({}, "https://vps.example.com:20128/v1", "t");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://vps.example.com:20128");
});

test("buildClaudeEnv sets CLAUDE_CONFIG_DIR for a profile", () => {
  const env = buildClaudeEnv({}, 20128, "t", { configDir: "/home/u/.claude/profiles/glm52" });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/u/.claude/profiles/glm52");
});

test("buildClaudeEnv strips inherited ANTHROPIC_* and does not mutate input", () => {
  const input = { ANTHROPIC_API_KEY: "leak", PATH: "/bin" };
  const env = buildClaudeEnv(input, 20128, "x");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(input.ANTHROPIC_API_KEY, "leak");
});

test("resolveLaunchTarget: explicit --remote wins, strips /v1", () => {
  const { baseUrl } = resolveLaunchTarget({ remote: "https://vps:20128/v1" });
  assert.equal(baseUrl, "https://vps:20128");
});

test("resolveLaunchTarget: explicit token wins over everything", () => {
  const { authToken } = resolveLaunchTarget({ remote: "http://x:20128", token: "tok-explicit" });
  assert.equal(authToken, "tok-explicit");
});
