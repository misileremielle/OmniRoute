// Kept in lockstep with the `@openai/codex@x.y.z` pin in the root Dockerfile
// (the CLI installed in the OmniRoute image). When that image pin is bumped,
// refresh this so the fingerprint OpenAI sees from the OAuth/Responses face
// matches the real client version. Overridable per-deployment via
// CODEX_CLIENT_VERSION.
//
// The User-Agent shape is the real client's, captured from openai/codex
// 0.172.0 (codex-rs/login/src/auth/default_client.rs → get_codex_user_agent):
//
//   {originator}/{version} ({os_type} {os_version}; {arch}) {terminal}
//
// e.g. `codex_cli_rs/0.172.0 (Linux 6.8.0-45-generic; x86_64) xterm-256color`.
// The OS token is the HOST's: the real binary reports os_info for the machine it
// runs on, so a fixed platform string is itself a tell. `terminal` is Codex's
// sanitized terminal-detection token (`unknown` when nothing is detectable).
// Bare `os`, not `node:os`: this module is reachable from a client bundle and the
// `node:` scheme has no client fallback (bare builtins are polyfilled by Next).
import { arch as hostArch, platform as hostPlatform, release as hostRelease } from "os";

export const DEFAULT_CODEX_CLIENT_VERSION = "0.172.0";
export const CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs";

/** os_info::Type display names, which is what the real UA prints. */
const CODEX_OS_TYPE: Record<string, string> = {
  linux: "Linux",
  darwin: "Mac OS",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  sunos: "Solaris",
  aix: "AIX",
};

/** os_info::Architecture display names. */
const CODEX_OS_ARCH: Record<string, string> = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "x86",
  arm: "arm",
  ppc64: "powerpc64",
  s390x: "s390x",
};

/** Anything outside the header-safe printable range would break the header. */
function sanitizeToken(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, "_");
}

export function getCodexOsType(): string {
  return CODEX_OS_TYPE[hostPlatform()] ?? hostPlatform();
}

export function getCodexOsArch(): string {
  return CODEX_OS_ARCH[hostArch()] ?? hostArch();
}

export function getCodexOsVersion(): string {
  // The real client prints the OS release (`os_info` version). Empty on the odd
  // platform that has none, so the token degrades to a single space rather than
  // to a malformed string.
  try {
    return sanitizeToken(hostRelease() || "") || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Codex's terminal token: `TERM_PROGRAM[/version]` first, then bare `TERM`, then
 * `unknown` (codex-rs/terminal-detection). Mirrors the fallback chain, not the
 * emulator table — a terminal we cannot identify still has to produce a token.
 */
export function getCodexTerminalToken(): string {
  const env = typeof process === "undefined" ? {} : (process.env as Record<string, string>);
  const program = env.TERM_PROGRAM?.trim();
  if (program) {
    const version = env.TERM_PROGRAM_VERSION?.trim();
    return version ? sanitizeToken(`${program}/${version}`) : sanitizeToken(program);
  }
  const term = env.TERM?.trim();
  return term ? sanitizeToken(term) : "unknown";
}

/** Version-parameterised so callers can advertise the caller's own CLI (#3960). */
export function buildCodexUserAgent(version: string): string {
  return `${CODEX_CLI_RS_ORIGINATOR}/${version} (${getCodexOsType()} ${getCodexOsVersion()}; ${getCodexOsArch()}) ${getCodexTerminalToken()}`;
}

export function getCodexCliRsHeaders(
  version = DEFAULT_CODEX_CLIENT_VERSION
): Record<string, string> {
  return {
    "User-Agent": buildCodexUserAgent(version),
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}
