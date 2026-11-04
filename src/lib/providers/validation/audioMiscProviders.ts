// Audio/speech + miscellaneous API-key provider validators: deepgram, assemblyai, elevenlabs,
// inworld, kie, aws-polly, bailian-coding-plan, reka, maritalk, nlpcloud, runwayml, nous-research,
// poe. Extracted from validation.ts (god-file decomposition) — top-level functions with no
// dispatcher-state captures; behavior is byte-identical to the original inline defs.
// Audio/speech + miscellaneous API-key provider validators: deepgram, assemblyai, elevenlabs,
// inworld, kie, aws-polly, bailian-coding-plan, reka, maritalk, nlpcloud, runwayml, nous-research,
// poe. Extracted from validation.ts (god-file decomposition) — top-level functions with no
// dispatcher-state captures; behavior is byte-identical to the original inline defs.
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { POE_DEFAULT_BASE_URL } from "@omniroute/open-sse/config/providers/registry/poe/index.ts";
import { normalizeBaseUrl } from "./urlHelpers";
import {
  applyCustomUserAgent,
  buildBearerHeaders,
  buildKeyHeaders,
  buildRekaHeaders,
  buildTokenHeaders,
} from "./headers";
import { toValidationErrorResult, validationRead, validationWrite } from "./transport";
import { validateDirectChatProvider } from "./directChatProbe";

import {
  buildMaritalkChatUrl,
  buildMaritalkModelsUrl,
} from "@omniroute/open-sse/config/maritalk.ts";

import { resolveAlibabaProviderBaseUrl } from "@/shared/constants/alibabaProviderRegions";

export async function validateKieProvider({ apiKey, providerSpecificData = {} }: any) {
  try {
    // Use credit check endpoint as requested by user based on Kie.ai docs.
    const response = await validationRead("https://api.kie.ai/api/v1/chat/credit", {
      method: "GET",
      headers: applyCustomUserAgent(
        {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        providerSpecificData
      ),
    });

    if (response.ok) {
      return { valid: true, error: null };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid Kie.ai API key" };
    }

    // Fallback: if credits endpoint is 404/not supported, try minimal chat probe.
    const chatRes = await validationWrite("https://api.kie.ai/api/v1/chat/completions", {
      method: "POST",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
      body: JSON.stringify({
        model: providerSpecificData.validationModelId || "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      }),
    });

    if (
      chatRes.ok ||
      (chatRes.status >= 400 &&
        chatRes.status < 500 &&
        chatRes.status !== 401 &&
        chatRes.status !== 403)
    ) {
      return { valid: true, error: null };
    }

    return { valid: false, error: `Validation failed: ${chatRes.status}` };
  } catch (error: unknown) {
    return toValidationErrorResult(error);
  }
}

export async function validateBailianCodingPlanProvider({
  apiKey,
  providerSpecificData = {},
}: any) {
  try {
    const rawBaseUrl = normalizeBaseUrl(
      resolveAlibabaProviderBaseUrl("bailian-coding-plan", providerSpecificData)
    );
    const baseUrl = rawBaseUrl.endsWith("/messages")
      ? rawBaseUrl.slice(0, -"/messages".length)
      : rawBaseUrl;
    // bailian-coding-plan uses DashScope Anthropic-compatible messages endpoint
    // It does NOT expose /v1/models — use messages probe directly
    const messagesUrl = `${baseUrl}/messages`;

    const response = await validationWrite(messagesUrl, {
      method: "POST",
      headers: applyCustomUserAgent(
        {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        providerSpecificData
      ),
      body: JSON.stringify({
        // qwen3-coder-plus belonged to the retired Coding Plan host and is absent from
        // BAILIAN_CODING_PLAN_MODELS; probe with a model this plan actually serves.
        model: providerSpecificData.validationModelId || "qwen3.7-max",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      }),
    });

    // 401/403 => invalid key. An expired/lapsed Token Plan subscription yields the
    // exact same upstream 401 invalid_api_key (observed live 2026-09-01: subscription
    // ended 08-23, the previously working key started failing), so name it as a cause.
    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        error:
          "Invalid API key — or the Token Plan subscription is expired/inactive; " +
          "check it in the Model Studio console",
      };
    }

    // Non-auth 4xx (e.g., 400 bad request) means auth passed but request was malformed
    if (response.status >= 400 && response.status < 500) {
      return { valid: true, error: null };
    }

    if (response.ok) {
      return { valid: true, error: null };
    }

    return { valid: false, error: `Validation failed: ${response.status}` };
  } catch (error: any) {
    return toValidationErrorResult(error);
  }
}

export async function validateQwenCloudTokenPlanProvider({
  apiKey,
  providerSpecificData = {},
}: any) {
  try {
    const baseUrl = normalizeBaseUrl(
      resolveAlibabaProviderBaseUrl("qwen-cloud-token-plan", providerSpecificData)
    ).replace(/\/chat\/completions$/i, "");
    const response = await validationWrite(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
      body: JSON.stringify({
        model: providerSpecificData.validationModelId || "qwen3.7-max",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      }),
    });

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }
    if (response.status === 429) {
      return {
        valid: true,
        error: null,
        warning: "Provider accepted the key but is rate limited (429)",
      };
    }
    if (response.ok || response.status === 400 || response.status === 422) {
      return { valid: true, error: null };
    }
    return { valid: false, error: `Validation failed: ${response.status}` };
  } catch (error: any) {
    return toValidationErrorResult(error);
  }
}

export async function validateRekaProvider({ apiKey, providerSpecificData = {} }: any) {
  const baseUrl = normalizeBaseUrl(providerSpecificData.baseUrl) || "https://api.reka.ai/v1";
  const headers = buildRekaHeaders(apiKey, providerSpecificData);

  try {
    const response = await validationRead(`${baseUrl}/models`, {
      method: "GET",
      headers,
    });

    if (response.ok) {
      return { valid: true, error: null, method: "reka_models" };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 429) {
      return {
        valid: true,
        error: null,
        method: "reka_models",
        warning: "Rate limited, but credentials are valid",
      };
    }
  } catch {
    // Fall through to the chat probe when /models is unavailable.
  }

  try {
    const response = await validationWrite(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: providerSpecificData.validationModelId || "reka-flash-3",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      }),
    });

    if (
      response.ok ||
      response.status === 400 ||
      response.status === 422 ||
      response.status === 429
    ) {
      return { valid: true, error: null, method: "reka_chat_probe" };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status >= 500) {
      return { valid: false, error: `Provider unavailable (${response.status})` };
    }
  } catch (error: any) {
    return toValidationErrorResult(error);
  }

  return { valid: false, error: "Connection failed while testing Reka" };
}

export async function validateMaritalkProvider({ apiKey, providerSpecificData = {} }: any) {
  const entry = getRegistryEntry("maritalk");
  const baseUrl = normalizeBaseUrl(providerSpecificData.baseUrl || entry?.baseUrl);
  const headers = buildKeyHeaders(apiKey, providerSpecificData);

  try {
    const modelsRes = await validationRead(buildMaritalkModelsUrl(baseUrl), {
      method: "GET",
      headers,
    });

    if (modelsRes.ok) {
      return { valid: true, error: null, method: "maritalk_models" };
    }

    if (modelsRes.status === 401 || modelsRes.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (modelsRes.status === 429) {
      return {
        valid: true,
        error: null,
        method: "maritalk_models",
        warning: "Rate limited, but credentials are valid",
      };
    }

    if (modelsRes.status >= 500) {
      return { valid: false, error: `Provider unavailable (${modelsRes.status})` };
    }
  } catch {
    // Fall through to the chat probe when /models cannot be reached.
  }

  const modelId =
    typeof providerSpecificData?.validationModelId === "string" &&
    providerSpecificData.validationModelId.trim()
      ? providerSpecificData.validationModelId.trim()
      : entry?.models?.[0]?.id || "sabia-4";

  return validateDirectChatProvider({
    url: buildMaritalkChatUrl(baseUrl),
    headers,
    body: {
      model: modelId,
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1,
    },
    providerSpecificData,
  });
}

export async function validateNlpCloudProvider({ apiKey, providerSpecificData = {} }: any) {
  const rawBaseUrl = normalizeBaseUrl(providerSpecificData.baseUrl) || "https://api.nlpcloud.io/v1";
  const baseUrl = rawBaseUrl.endsWith("/gpu") ? rawBaseUrl : `${rawBaseUrl.replace(/\/$/, "")}/gpu`;
  const modelId =
    typeof providerSpecificData.validationModelId === "string" &&
    providerSpecificData.validationModelId.trim()
      ? providerSpecificData.validationModelId.trim()
      : "chatdolphin";
  const headers = buildTokenHeaders(apiKey, providerSpecificData);

  try {
    const response = await validationWrite(`${baseUrl}/${modelId}/chatbot`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: "test",
        context: "You are a concise assistant.",
        history: [],
      }),
    });

    if (
      response.ok ||
      response.status === 400 ||
      response.status === 422 ||
      response.status === 429
    ) {
      return {
        valid: true,
        error: null,
        method: "nlpcloud_chatbot",
        ...(response.status === 429 ? { warning: "Rate limited, but credentials are valid" } : {}),
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status >= 500) {
      return { valid: false, error: `Provider unavailable (${response.status})` };
    }
  } catch (error: any) {
    return toValidationErrorResult(error);
  }

  return { valid: false, error: "Connection failed while testing NLP Cloud" };
}

export async function validateOneMinAiProvider({ apiKey, providerSpecificData = {} }: any) {
  const modelId =
    typeof providerSpecificData.validationModelId === "string" &&
    providerSpecificData.validationModelId.trim()
      ? providerSpecificData.validationModelId.trim()
      : "gpt-4o-mini";

  try {
    const response = await validationWrite("https://api.1min.ai/api/chat-with-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-KEY": apiKey },
      body: JSON.stringify({
        type: "UNIFY_CHAT_WITH_AI",
        model: modelId,
        promptObject: { prompt: "test" },
      }),
    });

    if (response.ok) {
      return { valid: true, error: null, method: "oneminai_chat_with_ai" };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 429) {
      return {
        valid: true,
        error: null,
        method: "oneminai_chat_with_ai",
        warning: "Rate limited, but credentials are valid",
      };
    }

    // 400/422 with a valid key still means the key authenticated — 1min.ai
    // rejects an unrecognized/unauthorized model this same way as a bad
    // request body, so a validation-shaped 4xx is treated as "key is valid".
    if (response.status === 400 || response.status === 422) {
      return { valid: true, error: null, method: "oneminai_chat_with_ai" };
    }

    if (response.status >= 500) {
      return { valid: false, error: `Provider unavailable (${response.status})` };
    }
  } catch (error: any) {
    return toValidationErrorResult(error);
  }

  return { valid: false, error: "Connection failed while testing 1min.ai" };
}

export async function validateNousResearchProvider({ apiKey, providerSpecificData = {} }: any) {
  const baseUrl =
    normalizeBaseUrl(providerSpecificData.baseUrl) || "https://inference-api.nousresearch.com/v1";
  const chatUrl = `${baseUrl}/chat/completions`;
  const modelId =
    typeof providerSpecificData.validationModelId === "string" &&
    providerSpecificData.validationModelId.trim()
      ? providerSpecificData.validationModelId.trim()
      : "Hermes-4-70B";

  try {
    const response = await validationWrite(chatUrl, {
      method: "POST",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
        tags: ["user=omniroute"],
      }),
    });

    if (response.ok) {
      return { valid: true, error: null, method: "nous_chat_completions" };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 429) {
      return {
        valid: true,
        error: null,
        method: "nous_chat_completions",
        warning: "Rate limited, but credentials are valid",
      };
    }

    if (response.status === 402) {
      return { valid: false, error: "Payment required or API key missing" };
    }

    if (response.status >= 500) {
      return { valid: false, error: `Provider unavailable (${response.status})` };
    }

    // #3881: any other non-auth 4xx (e.g. 400 model-not-found, 404, 422) means the
    // credentials were accepted — only the probe model/request shape was rejected.
    // Treat as valid (mirrors the longcat/nvidia validators) so a model rename upstream
    // can't make a working key read as "invalid".
    if (response.status >= 400 && response.status < 500) {
      return {
        valid: true,
        error: null,
        method: "nous_chat_completions",
        warning: `Credentials valid (probe returned ${response.status})`,
      };
    }
  } catch (error: any) {
    return toValidationErrorResult(error);
  }

  return { valid: false, error: "Connection failed while testing Nous Research" };
}

export async function validatePoeProvider({ apiKey, providerSpecificData = {} }: any) {
  const baseUrl = normalizeBaseUrl(providerSpecificData.baseUrl) || POE_DEFAULT_BASE_URL;
  const balanceUrl = new URL("/usage/current_balance", baseUrl).toString();

  try {
    const response = await validationRead(balanceUrl, {
      method: "GET",
      headers: buildBearerHeaders(apiKey, providerSpecificData),
    });

    if (response.ok) {
      return { valid: true, error: null, method: "poe_current_balance" };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 429) {
      return {
        valid: true,
        error: null,
        method: "poe_current_balance",
        warning: "Rate limited, but credentials are valid",
      };
    }

    if (response.status >= 500) {
      return { valid: false, error: `Provider unavailable (${response.status})` };
    }
  } catch (error: any) {
    return toValidationErrorResult(error);
  }

  return { valid: false, error: "Connection failed while testing Poe" };
}
