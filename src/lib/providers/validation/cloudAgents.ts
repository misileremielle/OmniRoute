// Cloud-agent provider key validators (jules, devin). Moved out of the removed web-cookie
// validator module webProvidersB.ts.
import { spawn } from "child_process";
import { toValidationErrorResult, validationWrite } from "./transport";

/** Jules API — GET /v1alpha/sources with X-Goog-Api-Key (see developers.google.com/jules/api). */
export async function validateJulesProvider({ apiKey }: { apiKey: string }) {
  try {
    const response = await validationWrite("https://jules.googleapis.com/v1alpha/sources", {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
      },
    });

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.ok) {
      return { valid: true, error: null };
    }

    const errorText = await response.text().catch(() => "");
    return {
      valid: false,
      error: errorText.trim() || `Jules API returned ${response.status}`,
    };
  } catch (error: unknown) {
    return toValidationErrorResult(error);
  }
}

/**
 * #devin-cli-key: fallback validator for CLI-format Devin keys.
 *
 * The devin provider's actual routing path (open-sse/executors/devin-cli.ts)
 * shells out to the Devin CLI binary and passes the connection's apiKey as
 * WINDSURF_API_KEY — never touching api.devin.ai. CLI keys (apk_user_…) are
 * rejected by the HTTP API, so a 401 from the HTTP probe is NOT evidence the
 * connection is broken. This runs the same probe the executor uses:
 * `devin acp --agent-type summarizer` with the key in the environment
 * (`devin models list` does NOT honor WINDSURF_API_KEY). Exit 0 = key works.
 */
async function validateDevinCliKeyFallback(
  apiKey: unknown
): Promise<{ valid: boolean; error: string | null }> {
  const bin = process.env.CLI_DEVIN_BIN?.trim() || "devin";
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ["acp", "--agent-type", "summarizer"], {
        env: { ...process.env, WINDSURF_API_KEY: String(apiKey || "") },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      child.on("error", () =>
        resolve({ valid: false, error: "Devin CLI not available for fallback validation" })
      );
      child.on("close", (code) => {
        if (code === 0) resolve({ valid: true, error: null });
        else resolve({ valid: false, error: `Devin CLI key check failed (exit ${code})` });
      });
    } catch {
      resolve({ valid: false, error: "Devin CLI fallback spawn failed" });
    }
  });
}

/**
 * Devin cloud-agent (Cognition) — GET /v1/sessions with Bearer auth
 * (see docs.devin.ai/api-reference/sessions/list-sessions). Distinct from the
 * "devin-cli" LLM provider (ACP), which is already wired via providerRegistry.
 */
export async function validateDevinCloudAgentProvider({
  apiKey,
  allowLocalSpawn = true,
}: {
  apiKey: string;
  /**
   * S-01 (#15159): whether this caller may cause the local Devin CLI fallback to
   * spawn. Defaults to permissive because the direct callers (credential-health
   * scheduler, VNC harvest — the latter is already loopback-gated) are internal.
   * Remote-reachable routes MUST pass `false` for non-loopback callers: the
   * fallback is `spawn(bin, ["acp","--agent-type","summarizer"])`, and Hard Rules
   * #15/#17 require loopback enforcement before any auth check so a leaked JWT via
   * tunnel cannot trigger process spawning.
   */
  allowLocalSpawn?: boolean;
}): Promise<{ valid: boolean; error: string | null; warning?: string }> {
  try {
    const response = await validationWrite("https://api.devin.ai/v1/sessions?limit=1", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status === 401 || response.status === 403) {
      // #devin-cli-key: CLI-format keys (apk_user_…) are rejected by the HTTP API
      // but are exactly what the devin-cli executor authenticates with (via
      // WINDSURF_API_KEY). Fall back to probing the CLI itself — the real
      // routing path — before declaring the key invalid.
      //
      // S-01 (#15159): that fallback spawns a child process, so it is skipped
      // entirely for callers that are not loopback. The HTTP verdict below is
      // unchanged — a rejected key is still invalid, just not re-probed on the
      // host on behalf of a remote caller.
      if (!allowLocalSpawn) {
        return { valid: false, error: "Invalid API key" };
      }
      const cliCheck = await validateDevinCliKeyFallback(apiKey);
      if (cliCheck.valid) {
        return {
          valid: true,
          error: null,
          warning: "HTTP API rejected this key; validated via Devin CLI instead",
        };
      }
      return { valid: false, error: "Invalid API key" };
    }

    if (response.ok) {
      return { valid: true, error: null };
    }

    const errorText = await response.text().catch(() => "");
    return {
      valid: false,
      error: errorText.trim() || `Devin API returned ${response.status}`,
    };
  } catch (error: unknown) {
    return toValidationErrorResult(error);
  }
}
