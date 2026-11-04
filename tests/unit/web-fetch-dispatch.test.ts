import test from "node:test";
import assert from "node:assert/strict";

// #7339 — proves the synthetic omniroute_web_fetch tool call (emitted by
// webFetchInterception.ts, Phase 3-4 of #3384) is routed through the same
// generic dispatch path already proven for omniroute_web_search
// (handleToolCallExecution -> builtinServerTools.web_fetch), including the
// error/abort-not-swallowed case (Hard Rule #6).
const { handleToolCallExecution } = await import("../../src/lib/serverTools/interception.ts");
const { builtinServerTools } = await import("../../src/lib/serverTools/builtins.ts");
const { OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME } =
  await import("../../open-sse/services/webFetchInterception.ts");

const originalWebFetchHandler = builtinServerTools.web_fetch;

test.after(() => {
  builtinServerTools.web_fetch = originalWebFetchHandler;
});

const contextWithFetchBuiltin = {
  apiKeyId: "key-a",
  sessionId: "session-1",
  requestId: "request-1",
  builtinToolNames: [OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME],
  provider: "openai",
  model: "gpt-5",
};

test("handleToolCallExecution routes omniroute_web_fetch to the web_fetch builtin handler and returns the tool-result envelope", async () => {
  let receivedInput: unknown;
  let receivedContext: unknown;
  builtinServerTools.web_fetch = async (input, context) => {
    receivedInput = input;
    receivedContext = context;
    return {
      success: true,
      provider: "firecrawl",
      url: input.url,
      content: "fetched content",
      links: [],
      metadata: null,
      screenshot_url: null,
    };
  };

  const result = await handleToolCallExecution(
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-fetch-1",
                function: {
                  name: OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME,
                  arguments: '{"url":"https://example.com"}',
                },
              },
            ],
          },
        },
      ],
    },
    "gpt-5",
    contextWithFetchBuiltin
  );

  assert.deepEqual(result.tool_results, [
    {
      tool_call_id: "call-fetch-1",
      output: JSON.stringify({
        success: true,
        provider: "firecrawl",
        url: "https://example.com",
        content: "fetched content",
        links: [],
        metadata: null,
        screenshot_url: null,
      }),
    },
  ]);
  assert.deepEqual(receivedInput, { url: "https://example.com" });
  assert.equal((receivedContext as { provider?: string }).provider, "openai");
  assert.equal((receivedContext as { model?: string }).model, "gpt-5");
});

test("an unknown tool name is left untouched when builtinToolNames does not include it (#2815 no-alias-no-dispatch)", async () => {
  const original = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call-fetch-2",
              function: {
                name: OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME,
                arguments: '{"url":"https://example.com"}',
              },
            },
          ],
        },
      },
    ],
  };

  const result = await handleToolCallExecution(original, "gpt-5", {
    apiKeyId: "key-a",
    sessionId: "session-1",
    requestId: "request-1",
    builtinToolNames: [],
  });

  assert.equal(result, original);
});

test("an error thrown mid-fetch (e.g. an aborted request) is surfaced, not silently dropped (Hard Rule #6)", async () => {
  builtinServerTools.web_fetch = async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    throw abortError;
  };

  const result = await handleToolCallExecution(
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-fetch-abort",
                function: {
                  name: OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME,
                  arguments: '{"url":"https://example.com"}',
                },
              },
            ],
          },
        },
      ],
    },
    "gpt-5",
    contextWithFetchBuiltin
  );

  assert.deepEqual(result.tool_results, [
    {
      tool_call_id: "call-fetch-abort",
      output: JSON.stringify({ error: "The operation was aborted" }),
    },
  ]);
});
