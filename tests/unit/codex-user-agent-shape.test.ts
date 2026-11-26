/**
 * The Codex wire image must be the one the real CLI emits:
 *
 *   {originator}/{version} ({os_type} {os_version}; {arch}) {terminal}
 *
 * (openai/codex → codex-rs/login/src/auth/default_client.rs → get_codex_user_agent).
 * Before this, OmniRoute emitted `codex-cli/{version} (Windows 10.0.26200; x64)`
 * with no terminal token and a `codex-cli/` prefix the real binary never uses.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CODEX_CLIENT_VERSION,
  getCodexCliRsHeaders,
} from "../../src/shared/constants/codexClient.ts";
import { getCodexDefaultHeaders, getCodexUserAgent } from "../../open-sse/config/codexClient.ts";

const UA_SHAPE =
  /^codex_cli_rs\/\d+\.\d+\.\d+ \([^;()]+ \S+; (x86_64|aarch64|arm64|x64)\) [\x21-\x7e]+$/;

test("the advertised User-Agent matches the real CLI shape", () => {
  const ua = getCodexUserAgent();
  assert.match(ua, UA_SHAPE);
  assert.ok(ua.startsWith(`codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION} (`));
});

test("the originator prefix is codex_cli_rs, never codex-cli", () => {
  assert.ok(!getCodexUserAgent().startsWith("codex-cli/"));
  assert.ok(!getCodexCliRsHeaders()["User-Agent"].startsWith("codex-cli/"));
});

test("an explicit version override replaces only the version", () => {
  assert.match(getCodexUserAgent("9.9.9"), UA_SHAPE);
  assert.ok(getCodexUserAgent("9.9.9").startsWith("codex_cli_rs/9.9.9 ("));
});

test("an unsafe version override falls back to the pin", () => {
  assert.ok(
    getCodexUserAgent("bad version").startsWith(`codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION} (`)
  );
});

test("the terminal token is header-safe and non-empty even with no TERM", () => {
  const saved = { TERM: process.env.TERM, TERM_PROGRAM: process.env.TERM_PROGRAM };
  try {
    delete process.env.TERM;
    delete process.env.TERM_PROGRAM;
    const token = getCodexUserAgent().split(") ")[1];
    assert.equal(token, "unknown");
  } finally {
    if (saved.TERM === undefined) delete process.env.TERM;
    else process.env.TERM = saved.TERM;
    if (saved.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.TERM_PROGRAM;
  }
});

test("a TERM_PROGRAM with its version becomes the terminal token", () => {
  const saved = { TERM: process.env.TERM, TERM_PROGRAM: process.env.TERM_PROGRAM };
  const savedVersion = process.env.TERM_PROGRAM_VERSION;
  try {
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.TERM_PROGRAM_VERSION = "3.5.0";
    assert.ok(getCodexUserAgent().endsWith(" iTerm.app/3.5.0"));
  } finally {
    if (saved.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.TERM_PROGRAM;
    if (savedVersion === undefined) delete process.env.TERM_PROGRAM_VERSION;
    else process.env.TERM_PROGRAM_VERSION = savedVersion;
    if (saved.TERM === undefined) delete process.env.TERM;
    else process.env.TERM = saved.TERM;
  }
});

test("the default header set carries no Version header (the real client sends none)", () => {
  const headers = getCodexDefaultHeaders();
  assert.equal(headers.Version, undefined);
  assert.ok(!("Version" in headers));
});
