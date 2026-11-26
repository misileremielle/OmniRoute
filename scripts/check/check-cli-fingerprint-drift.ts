/**
 * Compare the four captured CLI fingerprint pins against the published CLI.
 *
 * A pin is the version OmniRoute advertises on the wire. Upstream gates new
 * models on that version, so a pin behind the published CLI fails closed
 * here instead of failing as a 400 on the first request for the new model.
 *
 * Network failure is not drift: the caller records it and exits 0.
 *
 * Not every match is worth the same. A pin one PATCH behind the published CLI
 * keeps working — `@github/copilot` publishes most days, and blocking every PR
 * on it turned a security-relevant gate into noise people route around. So the
 * exit code blocks on a MAJOR or MINOR gap (the vendor gates models on those)
 * and on a patch gap deeper than `DEFAULT_PATCH_DRIFT_TOLERANCE`; a shallower
 * patch gap is printed as advisory. `--strict` collapses the tolerance to 0 for
 * the release checklist.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CLAUDE_CODE_CLIENT_VERSION } from "../../src/shared/constants/claudeCodeClient.ts";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../../src/shared/constants/codexClient.ts";
import { GITHUB_COPILOT_CLI_VERSION } from "../../open-sse/config/providerHeaderProfiles.ts";
import { GROK_BUILD_DEFAULT_CLIENT_VERSION } from "../../open-sse/config/grokBuild.ts";
import { ANTIGRAVITY_CLI_FALLBACK_VERSION } from "../../open-sse/services/antigravityVersion.ts";

const execFileAsync = promisify(execFile);

export type FingerprintId = "claude-code" | "codex" | "copilot" | "grok-build" | "antigravity";

export interface PublishedCliVersion {
  version: string;
  source: string;
}

export type DriftSeverity = "major" | "minor" | "patch" | "ahead" | "unknown";

export interface FingerprintDrift {
  id: FingerprintId;
  pinned: string;
  published: string | null;
  source: string;
  /** How far behind the pin is. Absent is treated as blocking. */
  severity?: DriftSeverity;
  /** Number of patch releases behind, when the gap is patch-only. */
  patchDistance?: number;
}

/**
 * Patch releases a pin may lag without failing the check. Copilot ships most
 * days; three keeps a fork from going red on a publish nobody decided about,
 * while still catching a pin that has genuinely rotted.
 */
export const DEFAULT_PATCH_DRIFT_TOLERANCE = 3;

interface FingerprintSource {
  id: FingerprintId;
  pinned: string;
  /** npm package whose `version` field is the wire version. Empty for a GitHub-release CLI. */
  npmPackage: string;
  /**
   * GitHub repo whose latest release tag is the wire version. Antigravity's `agy`
   * is a Go binary shipped only as release assets — there is no npm document, so
   * the npm path cannot see it and the pin rotted two minor lines behind.
   */
  githubRepo?: string;
  /**
   * Optional second package. grok's launcher (`@xai-official/grok`) is not the
   * binary that speaks the wire protocol; the platform package is. Its version
   * is read from the launcher's `optionalDependencies` (the binary a fresh
   * install actually gets), not from the platform package's own `latest`
   * dist-tag, which xAI stopped moving at 0.1.220 while shipping 1.x binaries.
   */
  platformPackage?: string;
}

export const FINGERPRINT_SOURCES: readonly FingerprintSource[] = [
  {
    id: "claude-code",
    pinned: CLAUDE_CODE_CLIENT_VERSION,
    npmPackage: "@anthropic-ai/claude-code",
  },
  {
    id: "codex",
    pinned: DEFAULT_CODEX_CLIENT_VERSION,
    npmPackage: "@openai/codex",
  },
  {
    id: "copilot",
    pinned: GITHUB_COPILOT_CLI_VERSION,
    npmPackage: "@github/copilot",
  },
  {
    id: "grok-build",
    pinned: GROK_BUILD_DEFAULT_CLIENT_VERSION,
    npmPackage: "@xai-official/grok",
    platformPackage: "@xai-official/grok-linux-x64",
  },
  {
    id: "antigravity",
    pinned: ANTIGRAVITY_CLI_FALLBACK_VERSION,
    npmPackage: "",
    githubRepo: "google-antigravity/antigravity-cli",
  },
];

function parseTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Classify how a pin sits against the published CLI. */
function classifyDrift(
  pinned: string,
  liveVersion: string
): Pick<FingerprintDrift, "severity" | "patchDistance"> {
  const pinnedParts = parseTriple(pinned);
  const liveParts = parseTriple(liveVersion);
  if (!pinnedParts || !liveParts) return { severity: "unknown" };
  const [pMajor, pMinor, pPatch] = pinnedParts;
  const [lMajor, lMinor, lPatch] = liveParts;
  if (lMajor !== pMajor) return { severity: lMajor > pMajor ? "major" : "ahead" };
  if (lMinor !== pMinor) return { severity: lMinor > pMinor ? "minor" : "ahead" };
  if (lPatch === pPatch) return {};
  if (lPatch < pPatch) return { severity: "ahead" };
  return { severity: "patch", patchDistance: lPatch - pPatch };
}

export function compareFingerprintPins(
  pins: Record<FingerprintId, string>,
  published: Record<FingerprintId, PublishedCliVersion | null>
): FingerprintDrift[] {
  const drift: FingerprintDrift[] = [];
  for (const source of FINGERPRINT_SOURCES) {
    const live = published[source.id];
    const pinned = pins[source.id];
    if (!live) {
      drift.push({
        id: source.id,
        pinned,
        published: null,
        source: source.npmPackage,
        severity: "unknown",
      });
      continue;
    }
    const { severity, patchDistance } = classifyDrift(pinned, live.version);
    if (severity) {
      drift.push({
        id: source.id,
        pinned,
        published: live.version,
        source: live.source,
        severity,
        ...(patchDistance === undefined ? {} : { patchDistance }),
      });
    }
  }
  return drift;
}

/** Drift that must fail the check rather than merely advise. */
export function isBlockingDrift(
  row: FingerprintDrift,
  patchTolerance = DEFAULT_PATCH_DRIFT_TOLERANCE
): boolean {
  switch (row.severity) {
    case "ahead":
      return false;
    case "patch":
      return (row.patchDistance ?? 0) > patchTolerance;
    default:
      return true;
  }
}

export function exitCodeForFingerprintCheck(
  unreachable: readonly string[],
  drift: readonly FingerprintDrift[],
  patchTolerance = DEFAULT_PATCH_DRIFT_TOLERANCE
): number {
  if (unreachable.length > 0) return 0;
  return drift.some((row) => isBlockingDrift(row, patchTolerance)) ? 1 : 0;
}

export async function readNpmVersion(pkg: string): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], {
    timeout: 30_000,
  });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`npm view ${pkg} version returned ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * The exact platform-binary version a launcher pins in `optionalDependencies`,
 * or null when it is absent or a range (a range is not a shipped binary).
 */
export function platformVersionFromLauncherDeps(
  optionalDependencies: unknown,
  platformPackage: string
): string | null {
  // `npm view <pkg> <field> --json` answers with an array when the resolved
  // version carries more than one dist-tag (grok's `latest` and `alpha`).
  const deps = Array.isArray(optionalDependencies)
    ? optionalDependencies[optionalDependencies.length - 1]
    : optionalDependencies;
  const version =
    deps && typeof deps === "object" ? (deps as Record<string, unknown>)[platformPackage] : null;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return null;
  }
  return version;
}

export async function readPlatformBinaryVersion(
  launcherPackage: string,
  platformPackage: string
): Promise<string> {
  const { stdout } = await execFileAsync(
    "npm",
    ["view", launcherPackage, "optionalDependencies", "--json"],
    { timeout: 30_000 }
  );
  const version = platformVersionFromLauncherDeps(JSON.parse(stdout || "null"), platformPackage);
  if (!version) {
    throw new Error(`${launcherPackage} does not pin ${platformPackage} to an exact version`);
  }
  return version;
}

/** Latest release tag of a GitHub repo, with any leading `v` stripped. */
export async function readGitHubReleaseVersion(repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "OmniRoute-CLI-drift/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${repo} releases/latest returned ${response.status}`);
  }
  const payload = (await response.json()) as { tag_name?: unknown; prerelease?: unknown };
  const tag =
    typeof payload.tag_name === "string" ? payload.tag_name.trim().replace(/^v/i, "") : "";
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`${repo} latest release tag ${JSON.stringify(tag)} is not a dotted triple`);
  }
  return tag;
}

async function main(): Promise<void> {
  const pins = Object.fromEntries(FINGERPRINT_SOURCES.map((s) => [s.id, s.pinned])) as Record<
    FingerprintId,
    string
  >;
  const published = {} as Record<FingerprintId, PublishedCliVersion | null>;
  const unreachable: string[] = [];

  for (const source of FINGERPRINT_SOURCES) {
    const pkg = source.githubRepo
      ? `github:${source.githubRepo}`
      : (source.platformPackage ?? source.npmPackage);
    try {
      const version = source.githubRepo
        ? await readGitHubReleaseVersion(source.githubRepo)
        : source.platformPackage
          ? await readPlatformBinaryVersion(source.npmPackage, source.platformPackage)
          : await readNpmVersion(pkg);
      published[source.id] = { version, source: pkg };
    } catch (error) {
      published[source.id] = null;
      unreachable.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (unreachable.length > 0) {
    console.warn("Could not read every published CLI version; not treating that as drift:");
    for (const line of unreachable) console.warn(`  - ${line}`);
  }

  const patchTolerance = process.argv.includes("--strict") ? 0 : DEFAULT_PATCH_DRIFT_TOLERANCE;
  const drift = compareFingerprintPins(pins, published);
  const blocking = drift.filter((row) => isBlockingDrift(row, patchTolerance));
  const advisory = drift.filter((row) => !isBlockingDrift(row, patchTolerance));
  const exitCode = exitCodeForFingerprintCheck(unreachable, drift, patchTolerance);

  if (exitCode === 0 && drift.length === 0) {
    console.log("CLI fingerprint pins match the published CLIs.");
  }
  if (advisory.length > 0) {
    console.warn("CLI fingerprint drift within tolerance (bump when convenient):");
    for (const row of advisory) {
      console.warn(
        `  - ${row.id}: pinned ${row.pinned}, published ${row.published} (${row.source}) [${row.severity}]`
      );
    }
  }
  if (exitCode === 1) {
    console.error("CLI fingerprint pins are behind the published CLI:");
    for (const row of blocking) {
      console.error(
        `  - ${row.id}: pinned ${row.pinned}, published ${row.published} (${row.source}) [${row.severity}]`
      );
    }
    console.error(
      "Bump the captured pin, or set the matching *_CLIENT_VERSION env, before shipping."
    );
  }
  process.exitCode = exitCode;
}

const isDirectExecution = process.argv[1]?.endsWith("check-cli-fingerprint-drift.ts");
if (isDirectExecution) {
  await main();
}
