/**
 * System One decisions registry (#13987) — pure backend resolution.
 *
 * Maps a client model id to the backend that serves it. No I/O; the route and
 * the proxy handler both live on top of this, mirroring rerankRegistry.
 *
 *   typesafe/jev-1.13            → native api.typesafe.ai   (model jev-1.13)
 *   jev-latest / (no model)      → native api.typesafe.ai   (default alias)
 *   openrouter/typesafe/jev-1.13 → openrouter alpha decisions (model typesafe/jev-1.13)
 *   openrouter/inception/…:free  → openrouter alpha decisions (model verbatim)
 *   cloudflare-ai/jev | cf/jev   → Workers AI /ai/run           (model typesafe/jev)
 *   cloudflare-ai/clef[-flash]   → Workers AI /ai/run/@cf/cloudflare/<model>
 *   ollama-local/<model>         → the ollama-local connection's /v1/systemone
 *
 * Anything else is not a decisions model → null (the route 400s with guidance).
 */

export const TYPESAFE_SYSTEMONE_PROVIDER_ID = "typesafe";
export const TYPESAFE_SYSTEMONE_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEMONE_URL = `${TYPESAFE_SYSTEMONE_BASE_URL}/v1/systemone`;
/** TypeSafe answers a bare or missing model with its latest Jev alias. */
export const TYPESAFE_SYSTEMONE_DEFAULT_MODEL = "jev-latest";

export const OPENROUTER_DECISIONS_PROVIDER_ID = "openrouter";
export const OPENROUTER_DECISIONS_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_DECISIONS_URL = `${OPENROUTER_DECISIONS_BASE_URL}/api/alpha/decisions`;

/** Workers AI; the account id comes from the `cloudflare-ai` connection. */
export const CLOUDFLARE_SYSTEMONE_PROVIDER_ID = "cloudflare-ai";
export const CLOUDFLARE_SYSTEMONE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";
/**
 * Public Cloudflare model id → Workers AI model. Allow-listed because the
 * Clef ids become part of the request path. Jev on Cloudflare draws AI Gateway
 * credits; Clef draws Workers AI neurons.
 */
export const CLOUDFLARE_SYSTEMONE_MODELS: Readonly<Record<string, string>> = {
  jev: "typesafe/jev",
  clef: "clef",
  "clef-flash": "clef-flash",
};
const CLOUDFLARE_SYSTEMONE_PREFIXES = ["cloudflare-ai/", "cf/"];

/**
 * Local Ollama (#14667). The URL comes from the `ollama-local` connection's base URL,
 * never from the request; the model id only travels in the JSON body.
 */
export const OLLAMA_LOCAL_SYSTEMONE_PROVIDER_ID = "ollama-local";
const OLLAMA_LOCAL_SYSTEMONE_PREFIX = "ollama-local/";
/** Plain Ollama model tags (`qwen3:8b`, `library/llama3.2:latest`); no whitespace or control chars. */
const OLLAMA_LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** Node id prefix for operator-added System One-compatible endpoints. */
export const SYSTEMONE_COMPATIBLE_PREFIX = "systemone-compatible-";
/** Initial base URL offered for a new System One-compatible endpoint (OpenRouter). */
export const SYSTEMONE_COMPATIBLE_DEFAULT_BASE_URL = "https://openrouter.ai/api";
export const SYSTEMONE_PATH = "/v1/systemone";

export type SystemOneBackend = "typesafe" | "openrouter" | "cloudflare" | "ollama-local" | "custom";

/** Minimal provider-node shape the resolver needs (pure — no DB access here). */
export interface SystemOneCompatibleNode {
  id: string;
  prefix?: string | null;
  baseUrl?: string | null;
  type?: string | null;
}

export interface SystemOneTarget {
  backend: SystemOneBackend;
  /** Provider id used for credential lookup ("typesafe" | "openrouter" | node id). */
  provider: string;
  /** Model id forwarded upstream (gateway prefix stripped). */
  upstreamModel: string;
  /**
   * Empty for "cloudflare" (the URL needs the connection's account id) and for
   * "ollama-local" (the URL is the connection's base URL).
   */
  upstreamUrl: string;
}

function resolveCloudflareTarget(model: string): SystemOneTarget | null | undefined {
  const prefix = CLOUDFLARE_SYSTEMONE_PREFIXES.find((p) => model.startsWith(p));
  if (!prefix) return undefined;
  const id = model.slice(prefix.length);
  const upstreamModel = Object.hasOwn(CLOUDFLARE_SYSTEMONE_MODELS, id)
    ? CLOUDFLARE_SYSTEMONE_MODELS[id]
    : undefined;
  if (!upstreamModel) return null;
  return {
    backend: "cloudflare",
    provider: CLOUDFLARE_SYSTEMONE_PROVIDER_ID,
    upstreamModel,
    upstreamUrl: "",
  };
}

function resolveOllamaLocalTarget(model: string): SystemOneTarget | null | undefined {
  if (!model.startsWith(OLLAMA_LOCAL_SYSTEMONE_PREFIX)) return undefined;
  const id = model.slice(OLLAMA_LOCAL_SYSTEMONE_PREFIX.length);
  if (!OLLAMA_LOCAL_MODEL_ID.test(id) || id.includes("..")) return null;
  return {
    backend: "ollama-local",
    provider: OLLAMA_LOCAL_SYSTEMONE_PROVIDER_ID,
    upstreamModel: id,
    upstreamUrl: "",
  };
}

/**
 * Resolve the request model to a backend. Pure — unit-tested directly.
 *
 * `openrouter/…` explicitly picks the OpenRouter alpha decisions endpoint and
 * may name any decisions-capable vendor id (`typesafe/jev-1.13`,
 * `inception/mercury-decide:free`, …). `typesafe/…` and bare `jev-*` aliases
 * route natively; versioned aliases (jev-1.13, jev-1.14, …) are forwarded
 * verbatim even though only `jev-latest`/`jev-preview` are advertised —
 * upstream accepts unlisted jev-* versions (#13987 Part 1).
 */
export function resolveSystemOneTarget(
  model: string | undefined,
  customNodes: readonly SystemOneCompatibleNode[] = []
): SystemOneTarget | null {
  const trimmed = (model ?? "").trim();
  const custom = resolveCustomSystemOneTarget(trimmed, customNodes);
  if (custom) return custom;
  if (!trimmed || trimmed === TYPESAFE_SYSTEMONE_DEFAULT_MODEL) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed || TYPESAFE_SYSTEMONE_DEFAULT_MODEL,
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  if (trimmed.startsWith("typesafe/")) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed.slice("typesafe/".length),
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  if (trimmed.startsWith("openrouter/")) {
    return {
      backend: "openrouter",
      provider: OPENROUTER_DECISIONS_PROVIDER_ID,
      upstreamModel: trimmed.slice("openrouter/".length),
      upstreamUrl: OPENROUTER_DECISIONS_URL,
    };
  }
  const cloudflare = resolveCloudflareTarget(trimmed);
  if (cloudflare !== undefined) return cloudflare;
  const ollamaLocal = resolveOllamaLocalTarget(trimmed);
  if (ollamaLocal !== undefined) return ollamaLocal;
  if (/^jev[-/]/i.test(trimmed)) {
    return {
      backend: "typesafe",
      provider: TYPESAFE_SYSTEMONE_PROVIDER_ID,
      upstreamModel: trimmed,
      upstreamUrl: TYPESAFE_SYSTEMONE_URL,
    };
  }
  return null;
}

/**
 * Normalize an operator-entered System One server root: accept the bare root
 * (`https://api.typesafe.ai`, `https://openrouter.ai/api`) as well as pasted
 * `/v1` or full `/v1/systemone` URLs, and return the root the
 * `/v1/systemone` path is appended to (mirrors the TypeSafe SDK `baseURL`).
 */
export function sanitizeSystemOneBaseUrl(baseUrl: string | null | undefined): string {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  base = base.replace(/\/v1\/systemone$/i, "").replace(/\/systemone$/i, "");
  if (/\/v1$/i.test(base) && !/:\/\/v1$/i.test(base)) base = base.slice(0, -3);
  return base.replace(/\/+$/, "");
}

export function systemOneEndpointUrl(baseUrl: string): string {
  return `${sanitizeSystemOneBaseUrl(baseUrl)}${SYSTEMONE_PATH}`;
}

function isOpenRouterBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * OpenRouter serves System One models under its own ids. Apply the mapping the
 * TypeSafe SDK documents for OpenRouter so bare TypeSafe names keep working:
 * `jev-latest` → `~typesafe/jev-latest` (OpenRouter's newest-Jev alias), any
 * other bare name → `typesafe/<name>`; author-prefixed ids pass unchanged.
 * Other servers receive the model verbatim (default `jev-latest`).
 */
export function normalizeSystemOneModelForBase(baseUrl: string, model: string): string {
  const trimmed = model.trim();
  if (!isOpenRouterBase(baseUrl)) return trimmed || TYPESAFE_SYSTEMONE_DEFAULT_MODEL;
  if (!trimmed || trimmed === TYPESAFE_SYSTEMONE_DEFAULT_MODEL) {
    return `~typesafe/${TYPESAFE_SYSTEMONE_DEFAULT_MODEL}`;
  }
  return trimmed.includes("/") ? trimmed : `typesafe/${trimmed}`;
}

/**
 * Operator-added System One-compatible endpoints are addressed as
 * `<node prefix>/<model>` (or the bare prefix for the server's default model).
 */
function resolveCustomSystemOneTarget(
  model: string,
  customNodes: readonly SystemOneCompatibleNode[]
): SystemOneTarget | null {
  if (!model) return null;
  for (const node of customNodes) {
    if (!node?.id?.startsWith(SYSTEMONE_COMPATIBLE_PREFIX)) continue;
    const prefix = (node.prefix || "").trim();
    const baseUrl = sanitizeSystemOneBaseUrl(node.baseUrl);
    if (!prefix || !baseUrl) continue;
    if (model !== prefix && !model.startsWith(`${prefix}/`)) continue;
    const rest = model === prefix ? "" : model.slice(prefix.length + 1);
    return {
      backend: "custom",
      provider: node.id,
      upstreamModel: normalizeSystemOneModelForBase(baseUrl, rest),
      upstreamUrl: systemOneEndpointUrl(baseUrl),
    };
  }
  return null;
}
