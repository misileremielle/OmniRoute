/**
 * TokenExtractionConfig — Login & cookie extraction configs for web-cookie providers
 *
 * Each config describes how to:
 *   1. Open a browser window/navigate to the provider's login page
 *   2. Detect successful login (URL change + token presence)
 *   3. Extract session cookies / tokens from the browser context
 *
 * Used by InAppLoginService (Electron BrowserWindow path) and
 * the Playwright-based login flow (dashboard API).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Describes where to extract credential data from after login */
export type TokenSource =
  | { type: "cookie"; name: string; domain?: string }
  | { type: "localStorage"; key: string }
  | { type: "sessionStorage"; key: string }
  | { type: "header"; name: string };

export interface PollingConfig {
  /** Milliseconds between extraction polls (default 1000) */
  pollInterval: number;
  /** Total timeout in ms (default 300000 = 5 min) */
  timeout: number;
  /** Minimum time in ms before first extraction attempt (default 5000) */
  minLoginTime: number;
}

export interface TokenExtractionConfig {
  /** Matches the executor's provider ID (e.g. "claude-web", "gemini-web") */
  providerId: string;
  /** Human-readable name shown in dashboard UI */
  displayName: string;
  /** The URL to navigate to for login */
  loginUrl: string;
  /** The provider's home page URL (for cookie domain binding) */
  homeUrl: string;
  /** Optional regex. If current URL matches → login is likely complete */
  successUrlPattern?: RegExp;
  /** Sources to extract credentials from after login */
  tokenSources: TokenSource[];
  /** Polling behaviour */
  pollingConfig: PollingConfig;
  /** Short instructions shown to the user in the login modal */
  instructions: string;
  /** Optional: cookie domain override for cookie injection */
  cookieDomain?: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_POLLING: PollingConfig = {
  pollInterval: 1000,
  timeout: 300_000,
  minLoginTime: 5000,
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function config(
  providerId: string,
  displayName: string,
  loginUrl: string,
  homeUrl: string,
  tokenSources: TokenSource[],
  instructions: string,
  opts?: {
    successUrlPattern?: RegExp;
    pollingConfig?: Partial<PollingConfig>;
    cookieDomain?: string;
  }
): TokenExtractionConfig {
  return {
    providerId,
    displayName,
    loginUrl,
    homeUrl,
    tokenSources,
    instructions,
    pollingConfig: { ...DEFAULT_POLLING, ...opts?.pollingConfig },
    successUrlPattern: opts?.successUrlPattern,
    cookieDomain: opts?.cookieDomain,
  };
}

// ─── Configuration Map ──────────────────────────────────────────────────────

const RAW_CONFIGS: TokenExtractionConfig[] = [
  // ── Volcano Engine Ark Console ───────────────────────────
  config(
    "volcengine-console",
    "Volcano Engine Ark Console",
    "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan",
    "https://console.volcengine.com",
    [
      { type: "cookie", name: "digest", domain: ".volcengine.com" },
      { type: "cookie", name: "AccountID", domain: ".volcengine.com" },
      { type: "cookie", name: "csrfToken", domain: ".volcengine.com" },
      { type: "cookie", name: "userInfo", domain: ".volcengine.com" },
    ],
    "Log in to the Volcano Engine Ark console. The console session is used to discover Agent/Coding Plan API keys and live quota usage.",
    {
      cookieDomain: ".volcengine.com",
      successUrlPattern: /console\.volcengine\.com\/ark/i,
      pollingConfig: { timeout: 300_000, minLoginTime: 3000 },
    }
  ),
];

// ─── Registry ───────────────────────────────────────────────────────────────

const CONFIG_MAP = new Map<string, TokenExtractionConfig>();

for (const cfg of RAW_CONFIGS) {
  CONFIG_MAP.set(cfg.providerId, cfg);
}

/** Get extraction config for a specific provider */
export function getExtractionConfig(providerId: string): TokenExtractionConfig | undefined {
  return CONFIG_MAP.get(providerId);
}

/** List all registered extraction configs */
export function listExtractionConfigs(): TokenExtractionConfig[] {
  return [...RAW_CONFIGS];
}

/** The shared config map — used by InAppLoginService */
export const TOKEN_EXTRACTION_CONFIGS = CONFIG_MAP;

// ─── Storage-token acceptance ───────────────────────────────────────────────

/**
 * Whether a localStorage/sessionStorage value read during login may be stored as
 * a credential. Any non-empty string is accepted.
 */
export function isAcceptableStorageToken(
  _providerId: string,
  _key: string,
  value: unknown
): value is string {
  return typeof value === "string" && value.length > 0;
}
