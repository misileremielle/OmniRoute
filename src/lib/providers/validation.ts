import { getEmbeddingProvider } from "@omniroute/open-sse/config/embeddingRegistry.ts";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import {
  isClaudeCodeCompatibleProvider,
  isAnthropicCompatibleProvider,
  isSystemOneCompatibleProvider,
  isLocalProvider,
  isOpenAICompatibleProvider,
  isSelfHostedChatProvider,
  providerAllowsOptionalApiKey,
  resolveProviderId,
} from "@/shared/constants/providers";
import { MODAL_DEFAULT_VALIDATION_MODEL_ID } from "@/shared/constants/modal";
import { usesCcWireImage } from "@omniroute/open-sse/services/ccWireImageBuiltins.ts";
import {
  isAlibabaRegionalProvider,
  resolveAlibabaProviderBaseUrl,
} from "@/shared/constants/alibabaProviderRegions";
import { buildProviderHeaders, buildProviderUrl } from "@omniroute/open-sse/services/provider.ts";

import {
  OPENAI_LIKE_FORMATS,
  GEMINI_LIKE_FORMATS,
  normalizeBaseUrl,
  addModelsSuffix,
  resolveBaseUrl,
} from "./validation/urlHelpers";
import { toValidationErrorResult } from "./validation/transport";
import { validateOpencodeProvider } from "./validation/opencode";
import { validateCloudflareAiProvider } from "./validation/cloudflareAi";
import {
  validateHerokuProvider,
  validateDatabricksProvider,
  validateDataRobotProvider,
  validateSnowflakeProvider,
  validateGigachatProvider,
  validateAzureOpenAIProvider,
  validateAzureAiProvider,
  validateWatsonxProvider,
  validateOciProvider,
  validateSapProvider,
} from "./validation/cloudProviders";
import {
  validateKieProvider,
  validateBailianCodingPlanProvider,
  validateQwenCloudTokenPlanProvider,
  validateRekaProvider,
  validateMaritalkProvider,
  validateNlpCloudProvider,
  validateNousResearchProvider,
} from "./validation/audioMiscProviders";
import { validateTypesafeProvider } from "./validation/typesafe";
import { validateSearchProvider, SEARCH_VALIDATOR_CONFIGS } from "./validation/searchProviders";
import {
  validateClarifaiProvider,
  validateEmbeddingApiProvider,
  validateJinaFoundationProvider,
  validateRerankApiProvider,
} from "./validation/embeddingProviders";
import {
  validateBedrockProvider,
  validateOpenAILikeProvider,
  validateGeminiLikeProvider,
  validateHuggingFaceProvider,
  validateOpenAICompatibleProvider,
} from "./validation/openaiFormat";
import {
  validateAnthropicLikeProvider,
  validateAnthropicCompatibleProvider,
  validateClaudeCodeCompatibleProvider,
} from "./validation/anthropicFormat";
import { bytezValidationResultFromStatus, validateBytezProvider } from "./validation/bytez";
import { validateAiHordeProvider } from "./validation/aihorde";
import { validateDifyProvider } from "./validation/dify";
import { validateInceptionProvider } from "./validation/inception";
import { validateClineProvider } from "./validation/cline";
import { validateKilocodeProvider } from "./validation/kilocode";
import { validateMegabrainProvider } from "./validation/megabrain";
import {
  validateV0VercelProvider,
  validateAuggieProvider,
  validateCursorApiProvider,
  validateQoderProvider,
  validateKiroProvider,
  validateGitlabProvider,
  validateVertexProvider,
  validateVertexPartnerProvider,
  validateLongcatProvider,
  validateNvidiaProvider,
  validateZaiProvider,
  validateXiaomiMimoProvider,
  validateXiaomiMimoTokenPlanProvider,
} from "./validation/specialtyInline";
// validateClaudeCodeCompatibleProvider has external importers (provider-nodes/validate route +
// tests) — re-export to preserve the historical public surface.
export { validateClaudeCodeCompatibleProvider };

// isRetryableProxyTarget + isSecurityBlockError now live in ./validation/transport. Re-export them
// here to preserve the historical public surface (tests + route handlers import them via this module).
export { isRetryableProxyTarget, isSecurityBlockError } from "./validation/transport";

// bytezValidationResultFromStatus has external importers (tests) — re-export to preserve the
// historical public surface. It lives in ./validation/bytez.
export { bytezValidationResultFromStatus };

export async function validateFreebuffProvider({ apiKey }: { apiKey: string }) {
  if (!apiKey) {
    return { valid: false, error: "Freebuff Auth Token required", unsupported: false };
  }
  try {
    const res = await fetch("https://www.codebuff.com/api/v1/freebuff/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "codebuff/0.1.0 (darwin-arm64)",
        "x-freebuff-model": "deepseek/deepseek-v4-flash",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok || res.status === 409) {
      return { valid: true, error: null };
    }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid or expired Freebuff Auth Token", unsupported: false };
    }
    const errText = await res.text().catch(() => "");
    return {
      valid: false,
      error: `Freebuff validation returned ${res.status}: ${errText.slice(0, 100)}`,
      unsupported: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Freebuff validation network error: ${msg}`, unsupported: false };
  }
}

export async function validateProviderApiKey({
  provider,
  apiKey,
  providerSpecificData = {},
  // S-01 (#15159): forwarded to specialty validators that can reach a local spawn
  // (the auggie and qoder CLI probes). Remote-reachable routes pass `false` for
  // non-loopback callers; direct/internal callers keep the permissive default.
  allowLocalSpawn = true,
  // A stored connection's own token columns (accessToken / refreshToken / expiresAt), so a
  // specialty validator judges the token the executor will actually use, not a stale paste.
  // Omitted when validating a credential that is not stored yet.
  credentials = {},
}: any) {
  provider = typeof provider === "string" ? resolveProviderId(provider) : provider;
  const requiresApiKey = !providerAllowsOptionalApiKey(provider);
  const isLocal = isLocalProvider(provider);

  if (!provider || (requiresApiKey && !apiKey)) {
    return { valid: false, error: "Provider and API key required", unsupported: false };
  }

  if (isOpenAICompatibleProvider(provider)) {
    try {
      return await validateOpenAICompatibleProvider({ apiKey, providerSpecificData });
    } catch (error: any) {
      return toValidationErrorResult(error);
    }
  }

  if (isSystemOneCompatibleProvider(provider)) {
    // Connection tests pass only the connection's own data; the endpoint root
    // lives on the provider node.
    let baseUrl = providerSpecificData?.baseUrl;
    if (!baseUrl) {
      const { getProviderNodeById } = await import("@/lib/db/providers");
      const node = (await getProviderNodeById(provider)) as { baseUrl?: string } | null;
      baseUrl = node?.baseUrl;
    }
    if (!baseUrl) {
      return { valid: false, error: "System One Compatible node not found", unsupported: false };
    }
    return validateTypesafeProvider({
      apiKey,
      baseUrl,
      model: providerSpecificData?.validationModelId,
      label: "System One endpoint",
    });
  }

  if (isAnthropicCompatibleProvider(provider)) {
    try {
      if (isClaudeCodeCompatibleProvider(provider)) {
        return await validateClaudeCodeCompatibleProvider({ apiKey, providerSpecificData });
      }
      return await validateAnthropicCompatibleProvider({
        apiKey,
        providerSpecificData,
        isLocal,
      });
    } catch (error: any) {
      return toValidationErrorResult(error);
    }
  }

  // Specialty validator bodies live in ./validation/* (god-file decomposition). The host still owns the SPECIALTY_VALIDATORS map below; only the
  // validator bodies were extracted as leaf functions taking `isLocal` where the original
  // closure captured it.

  // ── Specialty provider validation ──
  const SPECIALTY_VALIDATORS = {
    "cloudflare-ai": validateCloudflareAiProvider,
    "v0-vercel": ({ apiKey, providerSpecificData }: any) =>
      validateV0VercelProvider({ apiKey, providerSpecificData, isLocal }),
    auggie: validateAuggieProvider,
    "cursor-api": validateCursorApiProvider,
    aihorde: validateAiHordeProvider,
    qoder: validateQoderProvider,
    kiro: validateKiroProvider,
    freebuff: validateFreebuffProvider,
    huggingface: validateHuggingFaceProvider,
    // #11002: Dify serves no OpenAI-compatible route — only POST /v1/chat-messages.
    // The generic OpenAI-like probe 404s on /v1/models and /v1/chat/completions,
    // so every real app key was misreported as "endpoint not supported".
    dify: validateDifyProvider,
    // #5422: auth-only probe — Bytez 404s on every chat model until the account adds it to
    // its catalog, so the generic chat probe can't validate a fresh key.
    bytez: validateBytezProvider,
    // Inception Labs serves GET /v1/models without authentication (200 for any key), so the
    // generic OpenAI-like probe greened bogus keys. Probe the authenticated chat route instead.
    inception: validateInceptionProvider,
    // Cline and ClinePass serve unauthenticated GET /v1/models (open catalog returning 200 for any key)
    // and require streaming + Cline client headers on /chat/completions. Probe the authenticated route.
    cline: validateClineProvider,
    clinepass: (args: {
      apiKey?: string;
      providerSpecificData?: Record<string, unknown> | null;
      isLocal?: boolean;
    }) => validateClineProvider({ ...args, provider: "clinepass" }),
    // Kilo Code serves unauthenticated GET /models (open catalog returning 200 for any key).
    // Authenticate against /chat/completions with the required X-KILOCODE-EDITORNAME header.
    kilocode: validateKilocodeProvider,
    // MegaBrain's /api/openrouter/models is public too; its validator probes the
    // authenticated /api/profile/limits instead.
    megabrain: validateMegabrainProvider,
    kie: validateKieProvider,
    "bailian-coding-plan": validateBailianCodingPlanProvider,
    "qwen-cloud-token-plan": validateQwenCloudTokenPlanProvider,
    heroku: validateHerokuProvider,
    databricks: validateDatabricksProvider,
    datarobot: validateDataRobotProvider,
    watsonx: validateWatsonxProvider,
    oci: validateOciProvider,
    sap: validateSapProvider,
    bedrock: validateBedrockProvider,
    modal: ({ apiKey, providerSpecificData }: any) => {
      // Modal is bring-your-own-deploy — it requires a Base URL pointing to the user's
      // OpenAI-compatible Modal app. Without it, validateOpenAILikeProvider would build an
      // empty probe URL and trip parseOutboundUrl with a raw guard error ("Invalid outbound
      // URL: "). Surface an actionable message instead. See #9102.
      const baseUrl = (providerSpecificData?.baseUrl || "").trim();
      if (!baseUrl) {
        return {
          valid: false,
          error:
            "Modal requires a Base URL pointing to your OpenAI-compatible Modal app " +
            "(e.g. https://<workspace>--<app>.modal.run/v1). " +
            'Fill in the "Base URL override" field.',
        };
      }
      return validateOpenAILikeProvider({
        provider: "modal",
        apiKey,
        providerSpecificData,
        baseUrl: normalizeBaseUrl(baseUrl),
        modelId: MODAL_DEFAULT_VALIDATION_MODEL_ID,
        isLocal,
      });
    },
    "nous-research": validateNousResearchProvider,
    clarifai: validateClarifaiProvider,
    reka: validateRekaProvider,
    maritalk: validateMaritalkProvider,
    nlpcloud: validateNlpCloudProvider,
    typesafe: ({ apiKey }: any) => validateTypesafeProvider({ apiKey }),
    snowflake: validateSnowflakeProvider,
    gigachat: validateGigachatProvider,
    "azure-openai": validateAzureOpenAIProvider,
    "azure-ai": validateAzureAiProvider,
    "voyage-ai": ({ apiKey, providerSpecificData }: any) => {
      const embeddingProvider = getEmbeddingProvider("voyage-ai");
      return validateEmbeddingApiProvider({
        apiKey,
        providerSpecificData,
        url: embeddingProvider?.baseUrl,
        modelId: embeddingProvider?.models?.[0]?.id || "voyage-4-lite",
      });
    },
    "jina-ai": ({ apiKey, providerSpecificData }: any) =>
      validateJinaFoundationProvider({ apiKey, providerSpecificData }),
    gitlab: ({ apiKey, providerSpecificData }: any) =>
      validateGitlabProvider({ apiKey, providerSpecificData, isLocal }),
    vertex: validateVertexProvider,
    "vertex-partner": validateVertexPartnerProvider,
    longcat: ({ apiKey, providerSpecificData }: any) =>
      validateLongcatProvider({ apiKey, providerSpecificData, isLocal }),
    nvidia: validateNvidiaProvider,
    zai: validateZaiProvider,
    "xiaomi-mimo": ({ apiKey, providerSpecificData }: any) =>
      validateXiaomiMimoProvider({ apiKey, providerSpecificData, isLocal }),
    "xiaomi-mimo-token-plan": ({ apiKey, providerSpecificData }: any) =>
      validateXiaomiMimoTokenPlanProvider({ apiKey, providerSpecificData, isLocal }),
    // Search providers — use factored validator
    ...Object.fromEntries(
      Object.entries(SEARCH_VALIDATOR_CONFIGS).map(([id, configFn]) => [
        id,
        ({ apiKey, providerSpecificData }: any) => {
          const { url, init } = configFn(apiKey, providerSpecificData);
          return validateSearchProvider(url, init, providerSpecificData, isLocal, id);
        },
      ])
    ),
  };

  if (SPECIALTY_VALIDATORS[provider]) {
    try {
      return await SPECIALTY_VALIDATORS[provider]({
        apiKey,
        providerSpecificData,
        allowLocalSpawn,
        credentials,
      });
    } catch (error: any) {
      return toValidationErrorResult(error);
    }
  }

  const entry = getRegistryEntry(provider);
  if (!entry) {
    if (isSelfHostedChatProvider(provider)) {
      return await validateOpenAILikeProvider({
        provider,
        apiKey,
        baseUrl: resolveBaseUrl(null, providerSpecificData),
        providerSpecificData,
        modelId: "local-model",
        modelsUrl: addModelsSuffix(providerSpecificData?.baseUrl || ""),
        isLocal,
      });
    }
    return { valid: false, error: "Provider validation not supported", unsupported: true };
  }

  const modelId = entry.models?.[0]?.id || null;
  // (#532) Use testKeyBaseUrl if defined — some providers validate keys on a different endpoint
  // than where requests are sent (e.g. opencode-go validates on zen/v1, not zen/go/v1)
  const validationEntry = entry.testKeyBaseUrl
    ? { ...entry, baseUrl: entry.testKeyBaseUrl }
    : entry;
  const usesAlibabaRegionalEndpoint = isAlibabaRegionalProvider(provider);
  const baseUrl = usesAlibabaRegionalEndpoint
    ? resolveAlibabaProviderBaseUrl(provider, providerSpecificData, validationEntry.baseUrl)
    : resolveBaseUrl(validationEntry, providerSpecificData);

  try {
    // OpenCode Zen/Go: probe with the discovery identity, never a free-tier chat probe.
    if (entry.executor === "opencode") {
      return await validateOpencodeProvider({ provider, apiKey, providerSpecificData, isLocal });
    }

    if (OPENAI_LIKE_FORMATS.has(entry.format)) {
      return await validateOpenAILikeProvider({
        apiKey,
        baseUrl,
        headers: entry.headers || {},
        providerSpecificData,
        modelId,
        modelsUrl: usesAlibabaRegionalEndpoint ? "" : entry.testKeyModelsUrl || entry.modelsUrl,
        isLocal,
      });
    }

    if (entry.format === "claude") {
      // Built-in CC-wire-image providers (e.g. agentrouter, #6056/#6255) gate
      // their WAF on the dynamic Claude-Code fingerprint (User-Agent,
      // `?beta=true` chat path, anthropic-beta/x-app/X-Stainless-* headers).
      // The real chat-request path already routes through
      // buildProviderUrl/buildProviderHeaders for this; the validation probe
      // must use the SAME wire image or a genuinely valid key gets 403'd as
      // "unauthorized client detected" (#6377).
      if (usesCcWireImage(provider)) {
        const requestBaseUrl = buildProviderUrl(provider, modelId, true, { baseUrl });
        const requestHeaders = buildProviderHeaders(provider, { apiKey }, true);

        return await validateAnthropicLikeProvider({
          apiKey,
          baseUrl: requestBaseUrl,
          modelId,
          headers: requestHeaders,
          providerSpecificData,
          isLocal,
        });
      }

      const requestBaseUrl = `${baseUrl}${entry.urlSuffix || ""}`;
      const requestHeaders = {
        ...(entry.headers || {}),
      };

      if ((entry.authHeader || "").toLowerCase() === "x-api-key") {
        requestHeaders["x-api-key"] = apiKey;
      } else {
        requestHeaders["Authorization"] = `Bearer ${apiKey}`;
      }

      return await validateAnthropicLikeProvider({
        apiKey,
        baseUrl: requestBaseUrl,
        modelId,
        headers: requestHeaders,
        providerSpecificData,
        isLocal,
      });
    }

    if (GEMINI_LIKE_FORMATS.has(entry.format)) {
      return await validateGeminiLikeProvider({
        apiKey,
        baseUrl,
        providerSpecificData,
        authType: entry.authType,
        isLocal,
      });
    }

    if (entry.format === "antigravity") {
      const expiresAt =
        providerSpecificData?.tokenExpiresAt ||
        providerSpecificData?.expiresAt ||
        providerSpecificData?.expiry_date ||
        providerSpecificData?.expiryDate;
      const expiryMs =
        typeof expiresAt === "number"
          ? expiresAt
          : typeof expiresAt === "string" && expiresAt.trim()
            ? Date.parse(expiresAt)
            : Number.NaN;

      if (Number.isFinite(expiryMs) && expiryMs > 0 && expiryMs < Date.now()) {
        return {
          valid: false,
          error: "Antigravity OAuth token has expired. Re-import or refresh the CLI login.",
          unsupported: false,
        };
      }

      return { valid: true, error: null, unsupported: false };
    }

    return { valid: false, error: "Provider validation not supported", unsupported: true };
  } catch (error: any) {
    return toValidationErrorResult(error);
  }
}
