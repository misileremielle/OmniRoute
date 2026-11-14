import { resolveProviderAlias } from "./providerAlias.ts";

type ProviderModelAliasMap = Record<string, Record<string, string>>;

// Provider-scoped legacy model aliases. Kept in a client-safe leaf so dashboard
// components can canonicalize combo targets without importing the server-only
// routing and credential graph from services/model.ts.
const PROVIDER_MODEL_ALIASES: ProviderModelAliasMap = {
  openai: {
    "gpt-4o-mini": "gpt-4o-mini",
  },
  github: {
    "claude-4.5-opus": "claude-opus-4-5-20251101",
    "claude-opus-4.5": "claude-opus-4-5-20251101",
    "gemini-3-pro": "gemini-3.1-pro-preview",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-flash": "gemini-3-flash-preview",
    "raptor-mini": "oswe-vscode-prime",
  },
  gemini: {
    "gemini-3.1-pro": "gemini-3.1-pro-preview",
    "gemini-3-1-pro": "gemini-3.1-pro-preview",
  },
  nvidia: {
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "nvidia/gpt-oss-120b": "openai/gpt-oss-120b",
    "gpt-oss-20b": "openai/gpt-oss-20b",
    "nvidia/gpt-oss-20b": "openai/gpt-oss-20b",
  },
  antigravity: {},
  deepseek: {
    "deepseek-v4.1-flash": "deepseek-flash",
    "deepseek-4.1-flash": "deepseek-flash",
    "deepseek-v4-1-flash": "deepseek-flash",
  },
  // The first-party Anthropic registry lists dotted ids (and /v1/models exposes them), but the
  // Messages API only accepts the dashed form; a dotted id 404s upstream (#16406).
  anthropic: {
    "claude-opus-4.8": "claude-opus-4-8",
    "claude-opus-4.7": "claude-opus-4-7",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4.5": "claude-opus-4-5",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.5": "claude-sonnet-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
  },
  kiro: {
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-4-6": "claude-opus-4.6",
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
  },
  "zed-hosted": {
    "claude-haiku-4-5": "claude-haiku-4.5",
  },
};

export function hasProviderModelAlias(providerId: string, modelId: string): boolean {
  const aliases = PROVIDER_MODEL_ALIASES[providerId];
  return !!aliases && Object.prototype.hasOwnProperty.call(aliases, modelId);
}

export function resolveProviderModelAlias(
  providerOrAlias: string | null | undefined,
  modelId: string | null | undefined
) {
  if (!modelId || typeof modelId !== "string") return modelId;
  const providerId = resolveProviderAlias(providerOrAlias);
  if (typeof providerId !== "string") return modelId;
  const aliases = PROVIDER_MODEL_ALIASES[providerId];
  return aliases?.[modelId] || modelId;
}

export function resolveCanonicalProviderModel(
  providerOrAlias: string | null | undefined,
  modelId: string | null | undefined
) {
  if (!modelId || typeof modelId !== "string") {
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: modelId || null,
    };
  }

  const provider = resolveProviderAlias(providerOrAlias);
  return {
    provider,
    model: resolveProviderModelAlias(provider, modelId),
  };
}
