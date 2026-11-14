import test from "node:test";
import assert from "node:assert/strict";

const {
  validateProviderApiKey,
  validateClaudeCodeCompatibleProvider,
  validateCommandCodeProvider,
  isSecurityBlockError,
} = await import("../../src/lib/providers/validation.ts");

const { SafeOutboundFetchError } = await import("../../src/shared/network/safeOutboundFetch.ts");

const { __setTlsFetchOverrideForTesting: __setGrokTlsFetchOverride } =
  await import("../../open-sse/services/grokTlsClient.ts");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __setGrokTlsFetchOverride(null);
});

function toPlainHeaders(headers: HeadersInit | undefined) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key, String(value)])
  );
}

function metaAiSseText(content: string, streamingState = "DONE") {
  return `event: next
data: ${JSON.stringify({
    data: {
      sendMessageStream: {
        __typename: "AssistantMessage",
        id: "meta-msg-1",
        content,
        streamingState,
        error:
          streamingState === "ERROR"
            ? { message: content, code: null, stack: "Error: " + content }
            : null,
        contentRenderer: { __typename: "TextContentRenderer", text: content },
      },
    },
  })}

event: complete
data:

`;
}

test("validateCommandCodeProvider ignores caller baseUrl and chatPath overrides", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.commandcode.ai/provider/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer cc-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "command-code-validation-model");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const result = await validateCommandCodeProvider({
    apiKey: "cc-key",
    providerSpecificData: {
      baseUrl: "https://evil.example/api",
      chatPath: "/v1/chat/completions",
      validationModelId: "command-code-validation-model",
    },
  });

  assert.equal(result.valid, true);
});

test("validateCommandCodeProvider defaults probe model to DeepSeek flash", async () => {
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek/deepseek-v4-flash");
    return new Response("", { status: 400 });
  };

  const result = await validateCommandCodeProvider({ apiKey: "cc-key" });

  assert.deepEqual(result, { valid: true, error: null });
});

test("specialty providers surface network failures and non-auth upstream failures", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.match(/longcat/i)) {
      throw new Error("longcat offline");
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const longcat = await validateProviderApiKey({ provider: "longcat", apiKey: "lc-key" });

  assert.equal(longcat.error, "longcat offline");
});

test("embedding and rerank specialty validators cover Voyage AI and Jina AI", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.voyageai.com/v1/embeddings") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer voyage-key");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, "voyage-4-large");
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }

    if (target === "https://api.jina.ai/v1/models") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer jina-key");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const voyage = await validateProviderApiKey({ provider: "voyage-ai", apiKey: "voyage-key" });
  const jina = await validateProviderApiKey({ provider: "jina-ai", apiKey: "jina-key" });

  assert.equal(voyage.valid, true);
  assert.equal(jina.valid, true);
});

test("embedding and rerank specialty validators surface auth failures for Voyage AI and Jina AI", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === "https://api.voyageai.com/v1/embeddings") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    if (target === "https://api.jina.ai/v1/models") {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const voyage = await validateProviderApiKey({ provider: "voyage-ai", apiKey: "voyage-key" });
  const jina = await validateProviderApiKey({ provider: "jina-ai", apiKey: "jina-key" });

  assert.equal(voyage.error, "Invalid API key");
  assert.equal(jina.error, "Invalid API key (GET https://api.jina.ai/v1/models)");
});

test("v0-vercel specialty validator checks the Platform API chats endpoint", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.v0.dev/v1/chats?limit=1");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer v0-key");
    return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
  };

  const result = await validateProviderApiKey({
    provider: "v0-vercel",
    apiKey: "v0-key",
    providerSpecificData: {
      baseUrl: "https://api.v0.dev/v1/chat/completions",
    },
  });

  assert.deepEqual(result, {
    valid: true,
    error: null,
    method: "v0_platform_chats_list",
  });
});

test("v0-vercel specialty validator treats auth failures as invalid API key", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.v0.dev/v1/chats?limit=1");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer bad-v0-key");
    return new Response(JSON.stringify({ error: { type: "unauthorized_error" } }), {
      status: 401,
    });
  };

  const result = await validateProviderApiKey({
    provider: "v0-vercel",
    apiKey: "bad-v0-key",
    providerSpecificData: {
      baseUrl: "https://api.v0.dev/v1",
    },
  });

  assert.equal(result.error, "Invalid API key");
});

test("gitlab specialty validator accepts PAT auth on the direct access endpoint", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://gitlab.com/api/v4/code_suggestions/direct_access");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer glpat-test");
    return new Response(JSON.stringify({ token: "short-lived" }), { status: 200 });
  };

  const result = await validateProviderApiKey({ provider: "gitlab", apiKey: "glpat-test" });
  assert.equal(result.valid, true);
});

test("gitlab specialty validator treats 401 as invalid PAT", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const result = await validateProviderApiKey({ provider: "gitlab", apiKey: "glpat-bad" });
  assert.equal(result.error, "Invalid API key");
});

test("search provider validators cover success, client errors, server errors and custom user agent injection", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const target = String(url);
    if (target.match(/search\.brave\.com/i)) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (target.match(/api\.exa\.ai/i)) {
      return new Response(JSON.stringify({ error: "bad key" }), { status: 403 });
    }
    if (target.match(/api\.tavily\.com/i)) {
      return new Response(JSON.stringify({ error: "server" }), { status: 503 });
    }
    if (target.match(/api\.perplexity\.ai/i)) {
      throw new Error("perplexity offline");
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const brave = await validateProviderApiKey({
    provider: "brave-search",
    apiKey: "brave-key",
    providerSpecificData: { customUserAgent: "SearchSuite/1.0" },
  });
  const exa = await validateProviderApiKey({ provider: "exa-search", apiKey: "exa-key" });
  const tavily = await validateProviderApiKey({ provider: "tavily-search", apiKey: "tv-key" });
  const perplexity = await validateProviderApiKey({
    provider: "perplexity-search",
    apiKey: "px-key",
  });

  assert.equal(brave.valid, true);
  assert.equal(exa.error, "Invalid API key");
  assert.equal(tavily.error, "Validation failed: 503");
  assert.equal(perplexity.error, "perplexity offline");
  assert.equal(calls[0].init.headers["User-Agent"], "SearchSuite/1.0");
});

test("extended search provider validators cover Google PSE, Linkup, SearchAPI, You.com and SearXNG", async () => {
  const originalAllowPrivateProviderUrls = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";
  const calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const target = String(url);
      if (target.startsWith("https://www.googleapis.com/customsearch/v1")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (target.startsWith("https://api.linkup.so/v1/search")) {
        return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
      }
      if (target.startsWith("https://www.searchapi.io/api/v1/search")) {
        return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
      }
      if (target.startsWith("https://ydc-index.io/v1/search")) {
        return new Response(JSON.stringify({ results: { web: [] } }), { status: 200 });
      }
      if (target.startsWith("http://localhost:9999/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${target}`);
    };

    const google = await validateProviderApiKey({
      provider: "google-pse-search",
      apiKey: "google-key",
      providerSpecificData: { cx: "engine-id" },
    });
    const linkup = await validateProviderApiKey({
      provider: "linkup-search",
      apiKey: "linkup-key",
    });
    const searchapi = await validateProviderApiKey({
      provider: "searchapi-search",
      apiKey: "searchapi-key",
    });
    const youcom = await validateProviderApiKey({
      provider: "youcom-search",
      apiKey: "you-key",
    });
    const searxng = await validateProviderApiKey({
      provider: "searxng-search",
      providerSpecificData: { baseUrl: "http://localhost:9999/search" },
    });

    assert.equal(google.valid, true);
    assert.equal(linkup.valid, true);
    assert.equal(searchapi.valid, true);
    assert.equal(youcom.valid, true);
    assert.equal(searxng.valid, true);
    assert.match(calls[0].url, /cx=engine-id/);
    assert.equal(calls[1].init.headers.Authorization, "Bearer linkup-key");
    assert.match(calls[2].url, /api_key=searchapi-key/);
    assert.equal(calls[3].init.headers["X-API-Key"], "you-key");
  } finally {
    if (originalAllowPrivateProviderUrls === undefined) {
      delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
    } else {
      process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = originalAllowPrivateProviderUrls;
    }
  }
});

test("google PSE validator requires cx", async () => {
  const result = await validateProviderApiKey({
    provider: "google-pse-search",
    apiKey: "google-key",
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, "Programmable Search Engine ID (cx) is required");
});

test("google PSE validator rejects HTTP 400 (invalid key or cx) but keeps 429 valid", async () => {
  const statuses: number[] = [];
  let nextStatus = 400;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/www\.googleapis\.com\/customsearch\/v1/);
    statuses.push(nextStatus);
    return new Response(
      JSON.stringify({
        error: {
          code: nextStatus,
          status: nextStatus === 400 ? "INVALID_ARGUMENT" : "RESOURCE_EXHAUSTED",
          message: "upstream detail that must not be echoed",
        },
      }),
      { status: nextStatus }
    );
  };

  const rejected = await validateProviderApiKey({
    provider: "google-pse-search",
    apiKey: "bad-google-key",
    providerSpecificData: { cx: "bad-engine" },
  });
  assert.equal(rejected.valid, false);
  assert.equal(
    rejected.error,
    "Google PSE validation failed. Check the API key and Search Engine ID (cx)."
  );
  assert.equal(String(rejected.error).includes("upstream detail"), false);

  nextStatus = 429;
  const quotaExhausted = await validateProviderApiKey({
    provider: "google-pse-search",
    apiKey: "good-google-key",
    providerSpecificData: { cx: "engine-id" },
  });
  assert.equal(quotaExhausted.valid, true);
  assert.equal(quotaExhausted.error, null);
  assert.deepEqual(statuses, [400, 429]);
});

test("search validator keeps the lenient 400 policy for providers other than Google PSE", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "bad request" }), { status: 400 });

  const linkup = await validateProviderApiKey({
    provider: "linkup-search",
    apiKey: "linkup-key",
  });
  assert.equal(linkup.valid, true);
  assert.equal(linkup.error, null);
});

test("Maritalk validates with Key auth against the models endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), "https://chat.maritaca.ai/api/models");
    assert.equal(init.headers.Authorization, "Key maritalk-key");
    return new Response(JSON.stringify({ data: [{ id: "sabia-4" }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({
    provider: "maritalk",
    apiKey: "maritalk-key",
  });

  assert.equal(result.valid, true);
  assert.equal(result.method, "maritalk_models");
  assert.equal(calls.length, 1);
});

test("Maritalk falls back to chat probe when the models endpoint is unreachable", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url) === "https://chat.maritaca.ai/api/models") {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }

    assert.equal(String(url), "https://chat.maritaca.ai/api/chat/completions");
    assert.equal(init.headers.Authorization, "Key maritalk-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "sabia-4");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({
    provider: "maritalk",
    apiKey: "maritalk-key",
  });

  assert.equal(result.valid, true);
  assert.equal(calls.length, 2);
});

test("Maritalk treats a rate-limited models probe as valid credentials", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), "https://chat.maritaca.ai/api/models");
    assert.equal(init.headers.Authorization, "Key maritalk-key");
    return new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
    });
  };

  const result = await validateProviderApiKey({
    provider: "maritalk",
    apiKey: "maritalk-key",
  });

  assert.equal(result.valid, true);
  assert.equal(result.warning, "Rate limited, but credentials are valid");
  assert.equal(calls.length, 1);
});

test("local OpenAI-style providers validate without sending Authorization when apiKey is blank", async () => {
  const originalAllowPrivateProviderUrls = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";
  const calls = [];

  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 });
    };

    const lmStudio = await validateProviderApiKey({
      provider: "lm-studio",
      providerSpecificData: { baseUrl: "http://localhost:1234/v1" },
    });
    const vllm = await validateProviderApiKey({
      provider: "vllm",
      providerSpecificData: { baseUrl: "http://localhost:8000/v1" },
    });
    const lemonade = await validateProviderApiKey({
      provider: "lemonade",
      providerSpecificData: { baseUrl: "http://localhost:13305/api/v1" },
    });
    const llamaCpp = await validateProviderApiKey({
      provider: "llama-cpp",
      providerSpecificData: { baseUrl: "http://127.0.0.1:8080/v1" },
    });

    assert.equal(lmStudio.valid, true);
    assert.equal(vllm.valid, true);
    assert.equal(lemonade.valid, true);
    assert.equal(llamaCpp.valid, true);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "http://localhost:1234/v1/models",
        "http://localhost:8000/v1/models",
        "http://localhost:13305/api/v1/models",
        "http://127.0.0.1:8080/v1/models",
      ]
    );
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(calls[2].headers.Authorization, undefined);
    assert.equal(calls[3].headers.Authorization, undefined);
  } finally {
    if (originalAllowPrivateProviderUrls === undefined) {
      delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
    } else {
      process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = originalAllowPrivateProviderUrls;
    }
  }
});

test("OpenAI-compatible validator covers /responses mode and final ping fallback", async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method || "GET",
      body: typeof init.body === "string" ? init.body : undefined,
    });
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ error: "no models" }), { status: 500 });
    }
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify({ id: "resp_123" }), { status: 200 });
    }
    if (String(url) === "https://openai-like.example.com/v1") {
      return new Response("ok", { status: 418 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const responsesResult = await validateProviderApiKey({
    provider: "openai-compatible-responses",
    apiKey: "sk-test",
    providerSpecificData: {
      baseUrl: "https://openai-like.example.com/v1",
      apiType: "responses",
      validationModelId: "gpt-test",
    },
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ error: "server" }), { status: 500 });
    }
    if (String(url).endsWith("/chat/completions")) {
      throw new Error("chat probe offline");
    }
    return new Response("teapot", { status: 418 });
  };

  const pingFallback = await validateProviderApiKey({
    provider: "openai-compatible-ping-fallback",
    apiKey: "sk-test",
    providerSpecificData: {
      baseUrl: "https://openai-like.example.com/v1",
      validationModelId: "gpt-test",
    },
  });

  assert.equal(responsesResult.valid, true);
  assert.equal(responsesResult.method, "chat_completions");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://openai-like.example.com/v1/models", "https://openai-like.example.com/v1/responses"]
  );
  const responsesBody = JSON.parse(calls[1].body || "{}");
  assert.deepEqual(responsesBody.input, [{ role: "user", content: "test" }]);
  assert.equal(responsesBody.max_output_tokens, 1);
  assert.equal(responsesBody.messages, undefined);
  assert.equal(responsesBody.max_tokens, undefined);
  assert.equal(pingFallback.valid, true);
  assert.equal(pingFallback.error, null);
});

test("Anthropic-compatible and Claude Code compatible validators cover direct success and bridge fallbacks", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.match(/anthropic-compatible\.example\.com/i) && init.method === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (target.match(/cc-compatible\.example\.com/i) && init.method === "GET") {
      return new Response(JSON.stringify({ error: "bridge unavailable" }), { status: 500 });
    }
    if (target.match(/cc-compatible\.example\.com/i) && init.method === "POST") {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const anthropic = await validateProviderApiKey({
    provider: "anthropic-compatible-direct",
    apiKey: "sk-anthropic",
    providerSpecificData: {
      baseUrl: "https://anthropic-compatible.example.com/v1/messages",
      modelsPath: "/custom-models",
    },
  });

  const ccRateLimited = await validateClaudeCodeCompatibleProvider({
    apiKey: "sk-cc",
    providerSpecificData: {
      baseUrl: "https://cc-compatible.example.com/v1/messages",
      validationModelId: "claude-bridge-test",
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "GET") {
      return new Response(JSON.stringify({ error: "bridge unavailable" }), { status: 500 });
    }
    return new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 });
  };

  const ccFailure = await validateClaudeCodeCompatibleProvider({
    apiKey: "sk-cc",
    providerSpecificData: {
      baseUrl: "https://cc-compatible.example.com/v1/messages",
    },
  });

  assert.equal(anthropic.valid, true);
  assert.equal(ccRateLimited.valid, true);
  assert.equal(ccRateLimited.method, "cc_bridge_request");
  assert.match(ccRateLimited.warning, /Rate limited/i);
  assert.equal(ccFailure.valid, false);
  assert.equal(ccFailure.error, "Validation failed: 502");
});

test("Claude Code compatible validator rejects missing base URL and bridge auth failures", async () => {
  const missingBase = await validateClaudeCodeCompatibleProvider({
    apiKey: "sk-cc",
    providerSpecificData: {},
  });

  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "GET") {
      throw new Error("models offline");
    }
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  };

  const invalidKey = await validateClaudeCodeCompatibleProvider({
    apiKey: "sk-cc",
    providerSpecificData: {
      baseUrl: "https://cc-compatible.example.com/v1/messages",
    },
  });

  assert.equal(missingBase.error, "No base URL configured for CC Compatible provider");
  assert.equal(invalidKey.error, "Invalid API key");
});

test("registry providers cover remaining OpenAI-like and Claude-like validation branches", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {} });
    const target = String(url);

    if (target === "https://api.openai.com/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
    }
    if (target === "https://api.anthropic.com/v1/messages?beta=true") {
      return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const openaiModels = await validateProviderApiKey({ provider: "openai", apiKey: "sk-openai" });
  const claudeSuccess = await validateProviderApiKey({ provider: "claude", apiKey: "sk-claude" });

  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.openai.com/v1/models") {
      return new Response(JSON.stringify({ error: "server" }), { status: 500 });
    }
    if (String(url) === "https://api.openai.com/v1/chat/completions") {
      return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const openaiUnsupported = await validateProviderApiKey({
    provider: "openai",
    apiKey: "sk-openai",
  });

  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.openai.com/v1/models") {
      return new Response(JSON.stringify({ error: "server" }), { status: 500 });
    }
    if (String(url) === "https://api.openai.com/v1/chat/completions") {
      return new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const openaiInference = await validateProviderApiKey({ provider: "openai", apiKey: "sk-openai" });

  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.openai.com/v1/models") {
      return new Response(JSON.stringify({ error: "server" }), { status: 500 });
    }
    if (String(url) === "https://api.openai.com/v1/chat/completions") {
      return new Response(JSON.stringify({ error: "server" }), { status: 502 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const openaiUnavailable = await validateProviderApiKey({
    provider: "openai",
    apiKey: "sk-openai",
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const claudeInvalid = await validateProviderApiKey({ provider: "claude", apiKey: "sk-claude" });

  globalThis.fetch = async () => {
    throw new Error("anthropic offline");
  };
  const claudeOffline = await validateProviderApiKey({ provider: "claude", apiKey: "sk-claude" });

  assert.equal(openaiModels.valid, true);
  assert.equal(openaiModels.error, null);
  assert.equal(claudeSuccess.valid, true);
  assert.equal(openaiUnsupported.error, "Provider validation endpoint not supported");
  assert.equal(openaiInference.valid, true);
  assert.equal(openaiInference.error, null);
  assert.equal(openaiUnavailable.error, "Provider unavailable (502)");
  assert.equal(claudeInvalid.error, "Invalid API key");
  assert.equal(claudeOffline.error, "anthropic offline");
  assert.equal(calls[1].headers["x-api-key"], "sk-claude");
});

test("specialty validators cover remaining status branches for Bailian and LongCat", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    // Alibaba-family hosts: dashscope.aliyuncs.com (pay-as-you-go / AIGC) and
    // *.maas.aliyuncs.com (Token Plan).
    if (target.match(/(?:dashscope|maas)\.aliyuncs\.com/i)) {
      return new Response(JSON.stringify({ error: "server" }), { status: 500 });
    }
    if (target.match(/longcat/i)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const bailian = await validateProviderApiKey({
    provider: "bailian-coding-plan",
    apiKey: "bailian-key",
    providerSpecificData: {
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
    },
  });
  const longcatInvalid = await validateProviderApiKey({ provider: "longcat", apiKey: "lc-key" });

  globalThis.fetch = async (url) => {
    if (String(url).match(/longcat/i)) {
      return new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const longcatValid = await validateProviderApiKey({ provider: "longcat", apiKey: "lc-key" });

  assert.equal(bailian.error, "Validation failed: 500");
  assert.equal(longcatInvalid.error, "Invalid API key");
  assert.equal(longcatValid.valid, true);
});

test("specialty validators cover Heroku, Databricks, Snowflake and GigaChat success paths", async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    seen.push({ url: target, headers: init.headers || {} });

    if (target === "https://ngw.devices.sberbank.ru:9443/api/v2/oauth") {
      assert.equal(init.headers.Authorization, "Basic gigachat-basic-creds");
      return new Response(
        JSON.stringify({
          tok: "gigachat-access-token",
          exp: Date.now() + 60 * 60 * 1000,
        }),
        { status: 200 }
      );
    }
    if (target === "https://us.inference.heroku.com/v1/chat/completions") {
      assert.equal(init.headers.Authorization, "Bearer heroku-key");
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }
    if (
      target ===
      "https://adb-1234567890123456.7.azuredatabricks.net/serving-endpoints/chat/completions"
    ) {
      assert.equal(init.headers.Authorization, "Bearer databricks-key");
      return new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 });
    }
    if (target === "https://account.snowflakecomputing.com/api/v2/cortex/inference:complete") {
      assert.equal(init.headers.Authorization, "Bearer snowflake-token");
      assert.equal(
        init.headers["X-Snowflake-Authorization-Token-Type"],
        "PROGRAMMATIC_ACCESS_TOKEN"
      );
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }
    if (target === "https://gigachat.devices.sberbank.ru/api/v1/chat/completions") {
      assert.equal(init.headers.Authorization, "Bearer gigachat-access-token");
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const heroku = await validateProviderApiKey({
    provider: "heroku",
    apiKey: "heroku-key",
    providerSpecificData: { baseUrl: "https://us.inference.heroku.com" },
  });
  const databricks = await validateProviderApiKey({
    provider: "databricks",
    apiKey: "databricks-key",
    providerSpecificData: {
      baseUrl: "https://adb-1234567890123456.7.azuredatabricks.net/serving-endpoints",
    },
  });
  const snowflake = await validateProviderApiKey({
    provider: "snowflake",
    apiKey: "pat/snowflake-token",
    providerSpecificData: { baseUrl: "https://account.snowflakecomputing.com" },
  });
  const gigachat = await validateProviderApiKey({
    provider: "gigachat",
    apiKey: "gigachat-basic-creds",
  });

  assert.equal(heroku.valid, true);
  assert.equal(databricks.valid, true);
  assert.equal(snowflake.valid, true);
  assert.equal(gigachat.valid, true);
  assert.equal(
    seen.some((call) => call.url === "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"),
    true
  );
});

test("specialty validators surface missing base URLs and invalid auth for Heroku, Databricks, Snowflake and GigaChat", async () => {
  const missingHerokuBase = await validateProviderApiKey({
    provider: "heroku",
    apiKey: "heroku-key",
    providerSpecificData: {},
  });
  const missingDatabricksBase = await validateProviderApiKey({
    provider: "databricks",
    apiKey: "databricks-key",
    providerSpecificData: {},
  });
  const missingSnowflakeBase = await validateProviderApiKey({
    provider: "snowflake",
    apiKey: "snowflake-key",
    providerSpecificData: {},
  });

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === "https://ngw.devices.sberbank.ru:9443/api/v2/oauth") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    if (target === "https://us.inference.heroku.com/v1/chat/completions") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    if (
      target ===
      "https://adb-1234567890123456.7.azuredatabricks.net/serving-endpoints/chat/completions"
    ) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    if (target === "https://account.snowflakecomputing.com/api/v2/cortex/inference:complete") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const herokuInvalid = await validateProviderApiKey({
    provider: "heroku",
    apiKey: "heroku-key",
    providerSpecificData: { baseUrl: "https://us.inference.heroku.com" },
  });
  const databricksInvalid = await validateProviderApiKey({
    provider: "databricks",
    apiKey: "databricks-key",
    providerSpecificData: {
      baseUrl: "https://adb-1234567890123456.7.azuredatabricks.net/serving-endpoints",
    },
  });
  const snowflakeInvalid = await validateProviderApiKey({
    provider: "snowflake",
    apiKey: "snowflake-key",
    providerSpecificData: { baseUrl: "https://account.snowflakecomputing.com" },
  });
  const gigachatInvalid = await validateProviderApiKey({
    provider: "gigachat",
    apiKey: "gigachat-basic-creds-invalid",
  });

  assert.equal(missingHerokuBase.error, "Missing base URL");
  assert.equal(missingDatabricksBase.error, "Missing base URL");
  assert.equal(missingSnowflakeBase.error, "Missing base URL");
  assert.equal(herokuInvalid.error, "Invalid API key");
  assert.equal(databricksInvalid.error, "Invalid API key");
  assert.equal(snowflakeInvalid.error, "Invalid API key");
  assert.equal(gigachatInvalid.error, "Invalid API key");
});

test("specialty validator accepts DataRobot gateway and deployment credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://app.datarobot.com/genai/llmgw/catalog/") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer dr-key");
      return new Response(
        JSON.stringify({
          data: [{ model: "azure/gpt-5-mini-2025-08-07", isActive: true }],
        }),
        { status: 200 }
      );
    }

    if (
      target ===
      "https://app.datarobot.com/api/v2/deployments/65f5b2b7c8f8c4b257e0d123/chat/completions"
    ) {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer dr-deploy-key");
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, "datarobot-deployed-llm");
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const gateway = await validateProviderApiKey({
    provider: "datarobot",
    apiKey: "dr-key",
  });
  const deployment = await validateProviderApiKey({
    provider: "datarobot",
    apiKey: "dr-deploy-key",
    providerSpecificData: {
      baseUrl: "https://app.datarobot.com/api/v2/deployments/65f5b2b7c8f8c4b257e0d123",
    },
  });

  assert.equal(gateway.valid, true);
  assert.equal(deployment.valid, true);
});

test("specialty validator rejects invalid DataRobot credentials", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);

    if (target === "https://app.datarobot.com/genai/llmgw/catalog/") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    if (
      target ===
      "https://app.datarobot.com/api/v2/deployments/65f5b2b7c8f8c4b257e0d123/chat/completions"
    ) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const gateway = await validateProviderApiKey({
    provider: "datarobot",
    apiKey: "dr-key",
  });
  const deployment = await validateProviderApiKey({
    provider: "datarobot",
    apiKey: "dr-deploy-key",
    providerSpecificData: {
      baseUrl: "https://app.datarobot.com/api/v2/deployments/65f5b2b7c8f8c4b257e0d123",
    },
  });

  assert.equal(gateway.error, "Invalid API key");
  assert.equal(deployment.error, "Invalid API key");
});

test("specialty validators accept watsonx, OCI and SAP enterprise gateways", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://ca-tor.ml.cloud.ibm.com/ml/gateway/v1/models") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer watsonx-key");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    if (
      target === "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/models"
    ) {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer oci-key");
      assert.equal(headers["OpenAI-Project"], "ocid1.generativeaiproject.oc1.us-chicago-1.demo");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    if (target === "https://sap.example.com/v2/lm/scenarios/foundation-models/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer sap-key");
      assert.equal(headers["AI-Resource-Group"], "shared");
      return new Response(JSON.stringify({ resources: [] }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const watsonx = await validateProviderApiKey({
    provider: "watsonx",
    apiKey: "watsonx-key",
    providerSpecificData: { baseUrl: "https://ca-tor.ml.cloud.ibm.com" },
  });
  const oci = await validateProviderApiKey({
    provider: "oci",
    apiKey: "oci-key",
    providerSpecificData: {
      baseUrl: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com",
      projectId: "ocid1.generativeaiproject.oc1.us-chicago-1.demo",
    },
  });
  const sap = await validateProviderApiKey({
    provider: "sap",
    apiKey: "sap-key",
    providerSpecificData: {
      baseUrl: "https://sap.example.com/v2/lm/deployments/demo-deployment",
      resourceGroup: "shared",
    },
  });

  assert.equal(watsonx.valid, true);
  assert.equal(watsonx.method, "watsonx_models");
  assert.equal(oci.valid, true);
  assert.equal(oci.method, "oci_models");
  assert.equal(sap.valid, true);
  assert.equal(sap.method, "sap_models");
});

test("specialty validator accepts native Bedrock model discovery with a configured region", async () => {
  const seenUrls: string[] = [];

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    seenUrls.push(target);
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer bedrock-key");

    if (
      target === "https://bedrock.eu-west-2.amazonaws.com/foundation-models?byOutputModality=TEXT"
    ) {
      return new Response(
        JSON.stringify({
          modelSummaries: [
            {
              modelId: "anthropic.claude-sonnet-4-6",
              modelName: "Claude Sonnet 4.6",
              providerName: "Anthropic",
              inputModalities: ["TEXT", "IMAGE"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true,
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (
      target ===
      "https://bedrock.eu-west-2.amazonaws.com/inference-profiles?maxResults=100&typeEquals=SYSTEM_DEFINED"
    ) {
      return new Response(
        JSON.stringify({
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "eu.anthropic.claude-sonnet-4-6",
              inferenceProfileName: "EU Claude Sonnet 4.6",
              models: [
                {
                  modelArn:
                    "arn:aws:bedrock:eu-west-2::foundation-model/anthropic.claude-sonnet-4-6",
                },
              ],
            },
          ],
        }),
        { status: 200 }
      );
    }

    throw new Error("unexpected fetch: " + target);
  };

  const bedrock = await validateProviderApiKey({
    provider: "bedrock",
    apiKey: "bedrock-key",
    providerSpecificData: { region: "eu-west-2" },
  });

  assert.equal(bedrock.valid, true);
  assert.equal(bedrock.method, "bedrock_native_models");
  assert.deepEqual(seenUrls, [
    "https://bedrock.eu-west-2.amazonaws.com/foundation-models?byOutputModality=TEXT",
    "https://bedrock.eu-west-2.amazonaws.com/inference-profiles?maxResults=100&typeEquals=SYSTEM_DEFINED",
  ]);
});

test("specialty validator rejects invalid native Bedrock credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (
      target === "https://bedrock.eu-west-2.amazonaws.com/foundation-models?byOutputModality=TEXT"
    ) {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer bedrock-key");
      return new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
    }

    throw new Error("unexpected fetch: " + target);
  };

  const bedrock = await validateProviderApiKey({
    provider: "bedrock",
    apiKey: "bedrock-key",
    providerSpecificData: { region: "eu-west-2" },
  });

  assert.equal(bedrock.error, "Invalid API key");
});

test("specialty validators reject invalid watsonx, OCI and SAP credentials", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);

    if (target === "https://ca-tor.ml.cloud.ibm.com/ml/gateway/v1/models") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    if (
      target === "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/models"
    ) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }

    if (target === "https://sap.example.com/v2/lm/scenarios/foundation-models/models") {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const watsonx = await validateProviderApiKey({
    provider: "watsonx",
    apiKey: "watsonx-key",
    providerSpecificData: { baseUrl: "https://ca-tor.ml.cloud.ibm.com" },
  });
  const oci = await validateProviderApiKey({
    provider: "oci",
    apiKey: "oci-key",
    providerSpecificData: {
      baseUrl: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com",
    },
  });
  const sap = await validateProviderApiKey({
    provider: "sap",
    apiKey: "sap-key",
    providerSpecificData: {
      baseUrl: "https://sap.example.com/v2/lm/deployments/demo-deployment",
    },
  });

  assert.equal(watsonx.error, "Invalid API key");
  assert.equal(oci.error, "Invalid API key");
  assert.equal(sap.error, "Invalid API key");
});

test("specialty validator accepts Modal OpenAI-compatible deployments", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://alice--demo.modal.run/v1/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer modal-key");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const modal = await validateProviderApiKey({
    provider: "modal",
    apiKey: "modal-key",
    providerSpecificData: {
      baseUrl: "https://alice--demo.modal.run/v1",
    },
  });

  assert.equal(modal.valid, true);
});

test("specialty validator rejects invalid Modal credentials", async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);

    if (target === "https://alice--demo.modal.run/v1/models") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const modal = await validateProviderApiKey({
    provider: "modal",
    apiKey: "modal-key",
    providerSpecificData: {
      baseUrl: "https://alice--demo.modal.run/v1",
    },
  });

  assert.equal(modal.error, "Invalid API key");
});

test("specialty validator accepts Poe credentials on the current balance endpoint", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.poe.com/usage/current_balance") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer poe-key");
      return new Response(JSON.stringify({ current_point_balance: 123456 }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const poe = await validateProviderApiKey({
    provider: "poe",
    apiKey: "poe-key",
  });

  assert.equal(poe.valid, true);
  assert.equal(poe.method, "poe_current_balance");
});

test("specialty validator accepts Nous Research credentials on chat completions", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://inference-api.nousresearch.com/v1/chat/completions") {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body));
      assert.equal(headers.Authorization, "Bearer nous-key");
      assert.equal(body.model, "Hermes-4-70B");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-nous",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200 }
      );
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const nous = await validateProviderApiKey({
    provider: "nous-research",
    apiKey: "nous-key",
  });

  assert.equal(nous.valid, true);
  assert.equal(nous.method, "nous_chat_completions");
});

test("BytePlus key validation reaches the Ark endpoint instead of 'not supported' (#3877)", async () => {
  // #3877: byteplus was in APIKEY_PROVIDERS but never registered in the routing
  // registry, so validation returned {unsupported:true} → UI showed "invalid" for any
  // key. With the registry entry, a valid ark-... key probes the Ark /models endpoint
  // with Bearer auth and validates.
  let probedModelsUrl: string | null = null;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://ark.ap-southeast.bytepluses.com/api/v3/models") {
      probedModelsUrl = target;
      const headers = toPlainHeaders(init.headers);
      assert.equal(headers.Authorization, "Bearer ark-test-key");
      return new Response(JSON.stringify({ data: [{ id: "kimi-k2-thinking" }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const result = await validateProviderApiKey({
    provider: "byteplus",
    apiKey: "ark-test-key",
  });

  assert.equal(result.unsupported, undefined, "byteplus must not be 'validation not supported'");
  assert.equal(result.valid, true);
  assert.equal(probedModelsUrl, "https://ark.ap-southeast.bytepluses.com/api/v3/models");
});

test("specialty validator rejects invalid Nous Research credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://inference-api.nousresearch.com/v1/chat/completions") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer nous-bad");
      return new Response(JSON.stringify({ message: "invalid" }), { status: 401 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const nous = await validateProviderApiKey({
    provider: "nous-research",
    apiKey: "nous-bad",
  });

  assert.equal(nous.error, "Invalid API key");
});

test("specialty validator accepts Nous Research key when probe model is rejected (400)", async () => {
  // #3881: a valid key whose probe model is rejected (model-not-found / bad request)
  // must still validate — the 4xx proves auth was accepted, only the request shape
  // was wrong. Mirrors the longcat/nvidia validators.
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://inference-api.nousresearch.com/v1/chat/completions") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer nous-key");
      return new Response(
        JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } }),
        { status: 400 }
      );
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const nous = await validateProviderApiKey({
    provider: "nous-research",
    apiKey: "nous-key",
  });

  assert.equal(nous.valid, true);
  assert.equal(nous.method, "nous_chat_completions");
});

test("specialty validator rejects invalid Poe credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.poe.com/usage/current_balance") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer poe-bad");
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const poe = await validateProviderApiKey({
    provider: "poe",
    apiKey: "poe-bad",
  });

  assert.equal(poe.error, "Invalid API key");
});

test("specialty validator accepts Clarifai credentials through the OpenAI-compatible models probe", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.clarifai.com/v2/ext/openai/v1/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Key clarifai-pat");
      return new Response(
        JSON.stringify({ data: [{ id: "openai/chat-completion/models/gpt-oss-120b" }] }),
        { status: 200 }
      );
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const clarifai = await validateProviderApiKey({
    provider: "clarifai",
    apiKey: "clarifai-pat",
  });

  assert.equal(clarifai.valid, true);
  assert.equal(clarifai.method, "clarifai_models");
});

test("specialty validator rejects invalid Clarifai credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.clarifai.com/v2/ext/openai/v1/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Key clarifai-bad");
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const clarifai = await validateProviderApiKey({
    provider: "clarifai",
    apiKey: "clarifai-bad",
  });

  assert.equal(clarifai.error, "Invalid API key");
});

test("specialty validator accepts Reka credentials through the models probe with dual auth headers", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.reka.ai/v1/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer reka-key");
      assert.equal(headers["X-Api-Key"], "reka-key");
      return new Response(JSON.stringify([{ id: "reka-core" }]), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const reka = await validateProviderApiKey({
    provider: "reka",
    apiKey: "reka-key",
  });

  assert.equal(reka.valid, true);
  assert.equal(reka.method, "reka_models");
});

test("specialty validator rejects invalid Reka credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.reka.ai/v1/models") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer reka-bad");
      assert.equal(headers["X-Api-Key"], "reka-bad");
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const reka = await validateProviderApiKey({
    provider: "reka",
    apiKey: "reka-bad",
  });

  assert.equal(reka.error, "Invalid API key");
});

test("specialty validator accepts NLP Cloud credentials on the chatbot endpoint", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.nlpcloud.io/v1/gpu/chatdolphin/chatbot") {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body));
      assert.equal(headers.Authorization, "Token nlpc-key");
      assert.equal(body.input, "test");
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const nlpCloud = await validateProviderApiKey({
    provider: "nlpcloud",
    apiKey: "nlpc-key",
  });

  assert.equal(nlpCloud.valid, true);
  assert.equal(nlpCloud.method, "nlpcloud_chatbot");
});

test("specialty validator rejects invalid NLP Cloud credentials", async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target === "https://api.nlpcloud.io/v1/gpu/chatdolphin/chatbot") {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Token nlpc-bad");
      return new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 });
    }

    throw new Error(`unexpected fetch: ${target}`);
  };

  const nlpCloud = await validateProviderApiKey({
    provider: "nlpcloud",
    apiKey: "nlpc-bad",
  });

  assert.equal(nlpCloud.error, "Invalid API key");
});

test("validateCommandCodeProvider sends Command Code probe URL, headers, and flat OpenAI body", async () => {
  const calls: Array<{
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
  }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: toPlainHeaders(init.headers),
      body: JSON.parse(String(init.body)),
    });
    return new Response("", { status: 400 });
  };

  const result = await validateCommandCodeProvider({
    apiKey: "cc_test_key",
    providerSpecificData: { validationModelId: "gpt-5.4-mini" },
  });

  assert.deepEqual(result, { valid: true, error: null });
  assert.equal(calls.length, 1);
  // Probe targets the documented /provider/v1/chat/completions endpoint, not
  // the CLI-only /alpha/generate (#10265).
  assert.equal(calls[0].url, "https://api.commandcode.ai/provider/v1/chat/completions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer cc_test_key");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  // No CLI-impersonation headers.
  assert.equal(calls[0].headers["x-command-code-version"], undefined);
  assert.equal(calls[0].headers["x-cli-environment"], undefined);
  assert.equal(calls[0].headers["x-project-slug"], undefined);
  // Flat OpenAI chat.completions body (no CLI wrapper).
  assert.equal(calls[0].body.params, undefined, "CLI envelope params wrapper must not be sent");
  assert.equal(calls[0].body.model, "gpt-5.4-mini");
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.max_tokens, 1);
});

for (const status of [400, 422, 429]) {
  test(`validateCommandCodeProvider accepts ${status} as direct validator auth success`, async () => {
    globalThis.fetch = async () => new Response("", { status });
    assert.deepEqual(await validateCommandCodeProvider({ apiKey: "cc_test_key" }), {
      valid: true,
      error: null,
    });
  });
}

test("validateCommandCodeProvider rejects auth failures and provider outages", async () => {
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  assert.deepEqual(await validateCommandCodeProvider({ apiKey: "bad" }), {
    valid: false,
    error: "Invalid API key",
  });

  globalThis.fetch = async () => new Response("server down", { status: 500 });
  assert.deepEqual(await validateCommandCodeProvider({ apiKey: "cc_test_key" }), {
    valid: false,
    error: "Provider unavailable (500)",
  });
});

test("validateCommandCodeProvider falls back to /alpha/generate when /provider/v1 returns 403 (Go plan)", async () => {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({
      url: urlStr,
      headers: (init.headers || {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });

    if (urlStr.includes("/provider/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Your Go plan doesn't include API access.",
            type: "permission_error",
            code: "upgrade_required",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr.includes("/alpha/generate")) {
      return new Response("ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  };

  const result = await validateCommandCodeProvider({ apiKey: "cc_go_plan_key" });

  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes("/provider/v1/chat/completions"));
  assert.ok(calls[1].url.includes("/alpha/generate"));
  assert.equal(calls[1].headers["x-cli-environment"], "external");
  assert.equal(calls[1].headers["x-command-code-version"], "1.15.1");
  assert.equal(calls[1].body.config.environment, "external");
});

// ─── claude-web validator ────────────────────────────────────────────────────

const { __setTlsFetchOverrideForTesting: __setClaudeTlsFetchOverride } =
  await import("../../open-sse/services/claudeTlsClient.ts");

function makeClaudeTlsResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { status, ok: status >= 200 && status < 300, headers: h, text: body, body: null };
}

// #9406 inverted this contract: a 429 session shows as UNHEALTHY (valid:false)
// so the dashboard stops painting rate-limited sessions green. The dedicated
// repro (tests/unit/repro-9406-claude-web-429-valid.test.ts) owns the full
// contract incl. Retry-After forwarding; this sibling keeps the validator-level
// assertion aligned with it.
test("claude-web validator: 429 → invalid (rate limited session is not healthy, #9406)", async () => {
  __setClaudeTlsFetchOverride(async () =>
    makeClaudeTlsResponse(429, JSON.stringify({ error: "rate limited" }))
  );

  const result = await validateProviderApiKey({
    provider: "claude-web",
    apiKey: "sessionKey=sk-ant-sid02-good-key",
  });

  assert.equal(result.valid, false);
  __setClaudeTlsFetchOverride(null);
});

// ─── gemini-web validator ────────────────────────────────────────────────────

// ─── copilot-web validator ───────────────────────────────────────────────────

// ─── copilot-m365-web validator ──────────────────────────────────────────────

// ─── t3-web validator ────────────────────────────────────────────────────────

test("llama-cpp is classified as a self-hosted chat provider", async () => {
  const { isSelfHostedChatProvider, isLocalProvider, providerAllowsOptionalApiKey } =
    await import("../../src/shared/constants/providers.ts");

  assert.equal(isSelfHostedChatProvider("llama-cpp"), true);
  assert.equal(isLocalProvider("llama-cpp"), true);
  assert.equal(providerAllowsOptionalApiKey("llama-cpp"), true);
});

// ─── Gitlawb Opengateway specialty validators ──────────────────────────────

test("gitlawb validator: accepts valid API key via chat/completions probe", async () => {
  const calls: Array<{ url: string; headers?: HeadersInit; body?: BodyInit | null }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, body: init.body });
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/xiaomi-mimo/chat/completions");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer glb-valid-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "mimo-v2.5-pro");
    assert.equal(body.messages[0].content, "test");
    assert.equal(body.max_tokens, 1);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({ provider: "gitlawb", apiKey: "glb-valid-key" });
  assert.equal(result.valid, true);
  assert.equal(calls.length, 1);
});

test("gitlawb validator: 400/422/429 treated as auth success", async () => {
  for (const status of [400, 422, 429]) {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://opengateway.gitlawb.com/v1/xiaomi-mimo/chat/completions");
      return new Response(JSON.stringify({ error: "bad request" }), { status });
    };
    const result = await validateProviderApiKey({ provider: "gitlawb", apiKey: "glb-key" });
    assert.equal(result.valid, true, `status ${status} should pass auth`);
    assert.equal(result.error, null, `status ${status} should not return error`);
  }
});

test("gitlawb validator: rejects invalid API key (401)", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/xiaomi-mimo/chat/completions");
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };

  const result = await validateProviderApiKey({ provider: "gitlawb", apiKey: "glb-bad-key" });
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid API key");
});

test("gitlawb validator: rejects invalid API key (403)", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/xiaomi-mimo/chat/completions");
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  };

  const result = await validateProviderApiKey({ provider: "gitlawb", apiKey: "glb-bad-key" });
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid API key");
});

test("gitlawb validator: surfaces network failures", async () => {
  globalThis.fetch = async () => {
    throw new Error("gitlawb opengateway offline");
  };

  const result = await validateProviderApiKey({ provider: "gitlawb", apiKey: "glb-key" });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /gitlawb opengateway offline/i);
});

test("gitlawb validator: accepts custom baseUrl override", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://custom-gateway.example.com/v1/xiaomi-mimo/chat/completions");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer glb-key");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb",
    apiKey: "glb-key",
    providerSpecificData: {
      baseUrl: "https://custom-gateway.example.com/v1/xiaomi-mimo",
    },
  });
  assert.equal(result.valid, true);
});

// ─── Gitlawb-GMI (GMI Cloud) ─────────────────────────────────────────────

test("gitlawb-gmi validator: accepts valid API key via chat/completions probe", async () => {
  const calls: Array<{ url: string; headers?: HeadersInit }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/gmi-cloud/chat/completions");
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      "Bearer glb-gmi-valid-key"
    );
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "XiaomiMiMo/MiMo-V2.5-Pro");
    assert.equal(body.messages[0].content, "test");
    assert.equal(body.max_tokens, 1);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb-gmi",
    apiKey: "glb-gmi-valid-key",
  });
  assert.equal(result.valid, true);
  assert.equal(calls.length, 1);
});

test("gitlawb-gmi validator: accepts 400/422/429 as auth success", async () => {
  for (const status of [400, 422, 429]) {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://opengateway.gitlawb.com/v1/gmi-cloud/chat/completions");
      return new Response(JSON.stringify({ error: "bad request" }), { status });
    };
    const result = await validateProviderApiKey({
      provider: "gitlawb-gmi",
      apiKey: "glb-gmi-key",
    });
    assert.equal(result.valid, true, `status ${status} should pass auth`);
  }
});

test("gitlawb-gmi validator: rejects invalid API key (401)", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/gmi-cloud/chat/completions");
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb-gmi",
    apiKey: "glb-gmi-bad-key",
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid API key");
});

test("gitlawb-gmi validator: rejects invalid API key (403)", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://opengateway.gitlawb.com/v1/gmi-cloud/chat/completions");
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb-gmi",
    apiKey: "glb-gmi-bad-key",
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid API key");
});

test("gitlawb-gmi validator: surfaces network failures", async () => {
  globalThis.fetch = async () => {
    throw new Error("gitlawb-gmi opengateway offline");
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb-gmi",
    apiKey: "glb-gmi-key",
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /gitlawb-gmi opengateway offline/i);
});

test("gitlawb-gmi validator: accepts custom baseUrl override", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://custom-gateway.example.com/v1/gmi-cloud/chat/completions");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer glb-gmi-key");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({
    provider: "gitlawb-gmi",
    apiKey: "glb-gmi-key",
    providerSpecificData: {
      baseUrl: "https://custom-gateway.example.com/v1/gmi-cloud",
    },
  });
  assert.equal(result.valid, true);
});

// #3288 / #3758: a blocked redirect (REDIRECT_BLOCKED) to a PUBLIC host is benign — the
// redirect was never followed, so it must NOT be mislabeled as an SSRF security block.
// Only a redirect whose target is a private/internal host is a genuine security event.
test("isSecurityBlockError: public-host redirect block is NOT a security block", () => {
  const publicRedirect = new SafeOutboundFetchError("Redirect blocked", {
    code: "REDIRECT_BLOCKED",
    url: "https://public-provider.example.com/api/v2/models/",
    method: "GET",
    attempts: 1,
    status: 307,
    location: "https://public-provider.example.com/login",
    isRetryable: false,
  });
  assert.equal(isSecurityBlockError(publicRedirect), false);
});

test("isSecurityBlockError: private-host redirect block IS a security block", () => {
  const privateRedirect = new SafeOutboundFetchError("Redirect blocked", {
    code: "REDIRECT_BLOCKED",
    url: "https://api.example.com/probe",
    method: "GET",
    attempts: 1,
    status: 302,
    location: "http://169.254.169.254/latest/meta-data/",
    isRetryable: false,
  });
  assert.equal(isSecurityBlockError(privateRedirect), true);
});

test("isSecurityBlockError: a URL-guard block remains a security block", () => {
  const guardBlock = new SafeOutboundFetchError("Blocked private host", {
    code: "URL_GUARD_BLOCKED",
    url: "http://10.0.0.5/internal",
    method: "GET",
    attempts: 1,
    isRetryable: false,
  });
  assert.equal(isSecurityBlockError(guardBlock), true);
});

// ─── huggingface validator (whoami-v2 auth probe) ────────────────────────────
// Fine-grained HF Inference-Provider tokens are valid even when model/task
// endpoints reject them. The validator must probe whoami-v2 as a pure auth
// check: only 401/403 is invalid; any other non-OK status is transient.

test("huggingface validator accepts a token whoami-v2 recognizes", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: toPlainHeaders(init.headers) });
    return new Response(JSON.stringify({ name: "hf-user", auth: { type: "access_token" } }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_validtoken" });

  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(result.method, "huggingface_whoami");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://huggingface.co/api/whoami-v2");
  assert.equal(calls[0].headers.Authorization, "Bearer hf_validtoken");
});

test("huggingface validator treats 401/403 as an invalid token", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const unauthorized = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_bad" });
  assert.equal(unauthorized.valid, false);
  assert.equal(unauthorized.error, "Invalid API key");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  const forbidden = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_bad" });
  assert.equal(forbidden.valid, false);
  assert.equal(forbidden.error, "Invalid API key");
});

test("huggingface validator does NOT mark a fine-grained token invalid on a non-auth status", async () => {
  // This is the false-negative the port fixes: a 503/404 from a model/task
  // probe used to read as "invalid key". whoami-v2 returning a non-auth,
  // non-OK status must surface as a transient error, never "Invalid API key".
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });

  const result = await validateProviderApiKey({
    provider: "huggingface",
    apiKey: "hf_finegrained",
  });

  assert.equal(result.valid, false);
  assert.notEqual(result.error, "Invalid API key");
  assert.match(result.error || "", /HuggingFace token check returned 503/);
});
