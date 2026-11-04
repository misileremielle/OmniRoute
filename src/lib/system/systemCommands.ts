/**
 * Privileged-command helpers (sudo argv planning + password-safe execution)
 * used by the Tailscale tunnel install/funnel flow.
 */
import { execFileSync, spawn } from "child_process";
import os from "os";

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRoot(): boolean {
  try {
    return !!(process.getuid && process.getuid() === 0);
  } catch {
    return false;
  }
}

/**
 * Probe whether `sudo` is discoverable on PATH.
 *
 * Slim Docker images (e.g. `node:24-trixie-slim` used by OmniRoute's runtime
 * stage) do not ship `sudo`. When the container runs as a non-root user
 * (`USER node`, UID 1000), `spawn("sudo", ...)` fails with ENOENT and breaks
 * any privileged operation triggered from inside the container. `execFileWithPassword`
 * uses this probe to gracefully degrade: if sudo is missing and we are not
 * root, the underlying command is executed directly (same user, no elevation).
 *
 * Returns `false` on Windows — sudo is meaningless there (UAC path is used).
 * Read `os.platform()` at call time: a literal `process.platform` is
 * constant-folded to the Linux build host, so the published Windows artifact
 * would probe and then spawn native `sudo.exe` with POSIX `-S` (#11430).
 *
 * `execFileSync` is invoked with a fixed-string `command` and `args`,
 * never user input, and `stdio: "ignore"` so the probe is silent.
 */
export function isSudoAvailable(): boolean {
  if (os.platform() === "win32") return false;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    execFileSync("sh", ["-c", "command -v sudo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Truthy-env check for `OMNIROUTE_NO_SUDO`. Inlined (not imported from
 * `src/lib/db/apiKeys/modelPermissions.ts`) because that module pulls in the DB
 * read-cache graph and importing it here — into a low-level system primitive —
 * would create a module cycle. The same tiny
 * helper is already duplicated locally in `runtimeSettings.ts` / `db/settings.ts`
 * for exactly this reason; behavior matches `isTruthyEnvFlag` byte-for-byte
 * (`1|true|yes|on`, case-insensitive, trimmed).
 */
export function isNoSudoEnv(): boolean {
  const value = process.env.OMNIROUTE_NO_SUDO;
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export interface ResolvedSpawn {
  finalCommand: string;
  finalArgs: string[];
  stripSudo: boolean;
  needsPassword: boolean;
}

/**
 * Pure resolver for the sudo-stripping decision. Extracted so tests can assert
 * the resulting argv (and whether a password is written to stdin) WITHOUT
 * spawning a real `sudo`. `root`/`sudoAvailable` default to the live probes and
 * can be injected for deterministic tests; `noSudo` defaults to the
 * `OMNIROUTE_NO_SUDO` env flag.
 *
 * Strips the leading `sudo -S` (running the underlying command directly, same
 * user, no elevation) when running as root, when `sudo` is unavailable, OR when
 * the operator opts into root-less mode via `OMNIROUTE_NO_SUDO` (#6122). No
 * runtime value is ever interpolated into a shell — the argv array is preserved
 * and only the leading `sudo`/`-S` tokens are dropped (Hard Rule #13).
 */
export function resolveSudoSpawn(
  command: string,
  args: string[],
  overrides: { root?: boolean; sudoAvailable?: boolean; noSudo?: boolean } = {}
): ResolvedSpawn {
  const root = overrides.root ?? isRoot();
  const sudoAvailable = overrides.sudoAvailable ?? isSudoAvailable();
  const noSudo = overrides.noSudo ?? isNoSudoEnv();
  const stripSudo = command === "sudo" && (root || !sudoAvailable || noSudo);
  const needsPassword = !stripSudo && command === "sudo";
  let finalCommand = command;
  let finalArgs = args;

  if (stripSudo) {
    const realCmdIndex = args.findIndex((arg) => !arg.startsWith("-"));
    if (realCmdIndex !== -1) {
      finalCommand = args[realCmdIndex];
      finalArgs = args.slice(realCmdIndex + 1);
    }
  }

  return { finalCommand, finalArgs, stripSudo, needsPassword };
}

/** One process to spawn: argv plus exactly what is written to its stdin. */
export interface SudoStep {
  command: string;
  args: string[];
  stdin: string;
}

type SpawnLike = typeof spawn;

/**
 * GHSA-cqwr-7mqw-chr9: plan the processes for a `sudo -S <cmd>` call so the password
 * never shares a stdin with the elevated command.
 *
 * The old single call wrote `password\n<data>` to `sudo -S <cmd>`. When sudo does not
 * prompt (NOPASSWD, or a cached credential — which `sudo -n true` probes refresh), it never
 * reads stdin, so `<cmd>` received the password as data: `sudo -S tee -a /etc/hosts`
 * appended the operator's sudo password to the world-readable hosts file.
 *
 * Now the password goes only to `sudo -S -v` (validate, runs no command; if sudo does
 * not prompt, the unread line dies with that process), and the command runs as
 * `sudo -n <cmd>` with only its own data on stdin. Returns a single plain step when sudo
 * is stripped (root / no sudo / OMNIROUTE_NO_SUDO), exactly as before.
 */
export function planSudoSteps(
  command: string,
  args: string[],
  password: string,
  stdinAfterPassword = "",
  overrides: { root?: boolean; sudoAvailable?: boolean; noSudo?: boolean } = {}
): { steps: SudoStep[]; fallback: SudoStep | null } {
  const { finalCommand, finalArgs, needsPassword } = resolveSudoSpawn(command, args, overrides);
  if (!needsPassword) {
    return {
      steps: [{ command: finalCommand, args: finalArgs, stdin: stdinAfterPassword || "" }],
      fallback: null,
    };
  }
  let firstReal = 0;
  while (firstReal < args.length && args[firstReal] === "-S") firstReal++;
  const commandArgs = args.slice(firstReal);
  return {
    steps: [
      { command: "sudo", args: ["-S", "-p", "", "-v"], stdin: `${password}\n` },
      { command: "sudo", args: ["-n", ...commandArgs], stdin: stdinAfterPassword || "" },
    ],
    // Hosts with `timestamp_timeout=0` never keep the credential from `-v`, so
    // `sudo -n` refuses. There sudo is certain to prompt, so it consumes the
    // password line itself and nothing reaches the command.
    fallback: {
      command: "sudo",
      args: ["-S", ...commandArgs],
      stdin: `${password}\n${stdinAfterPassword}`,
    },
  };
}

function runStep(
  step: SudoStep,
  spawnImpl: SpawnLike
): Promise<{ code: number | null; stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    // `command` and `args` are never user-controlled. This helper is a
    // controlled wrapper called only with fixed executables (see
    // src/lib/tailscaleTunnel.ts). `spawn` is used (not `exec`) so each arg is a separate argv entry and
    // shell metacharacters do not expand. See docs/security/SOCKET_DEV_FINDINGS.md §3.
    // nosemgrep
    const child = spawnImpl(step.command, step.args, {
      // nosemgrep
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (code: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, error });
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle(null, error));
    child.on("close", (code) => settle(code, null));
    if (step.stdin) {
      child.stdin?.write(step.stdin);
    }
    child.stdin?.end();
  });
}

const SUDO_PASSWORD_REQUIRED = /a password is required/i;

export async function execFileWithPassword(
  command: string,
  args: string[],
  password: string,
  stdinAfterPassword = "",
  deps: {
    spawnImpl?: SpawnLike;
    sudoOverrides?: { root?: boolean; sudoAvailable?: boolean; noSudo?: boolean };
  } = {}
): Promise<string> {
  // When running as root, when `sudo` is not installed on the host (slim
  // Docker images / containerized non-root runtime), OR when the operator sets
  // `OMNIROUTE_NO_SUDO` (root-less / user-namespace deployments — #6122), skip
  // `sudo -S` and run the underlying command directly — same user, no
  // elevation. This lets privileged operations triggered from inside
  // `node:*-slim` containers succeed for any command that does not actually
  // require root.
  const spawnImpl = deps.spawnImpl ?? spawn;
  const { steps, fallback } = planSudoSteps(
    command,
    args,
    password,
    stdinAfterPassword,
    deps.sudoOverrides
  );

  let stdout = "";
  for (let i = 0; i < steps.length; i++) {
    const result = await runStep(steps[i], spawnImpl);
    const canFallBack = i === steps.length - 1 && fallback !== null;
    if (canFallBack && needsSudoPasswordFallback(result)) {
      return runStepOrThrow(fallback, spawnImpl);
    }
    stdout = stepOutputOrThrow(result);
  }
  return stdout;
}

type StepResult = Awaited<ReturnType<typeof runStep>>;

/** `sudo -n` refused because this host never keeps a credential (`timestamp_timeout=0`). */
function needsSudoPasswordFallback(result: StepResult): boolean {
  return !result.error && result.code !== 0 && SUDO_PASSWORD_REQUIRED.test(result.stderr);
}

function stepOutputOrThrow(result: StepResult): string {
  if (result.error) {
    throw new Error(`Command failed: ${getErrorMessage(result.error)}\n${result.stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(`Command failed with code ${result.code}\n${result.stderr}`);
  }
  return result.stdout;
}

async function runStepOrThrow(step: SudoStep, spawnImpl: SpawnLike): Promise<string> {
  return stepOutputOrThrow(await runStep(step, spawnImpl));
}
