import test from "node:test";
import assert from "node:assert/strict";

const { builtinServerTools } = await import("../../src/lib/serverTools/builtins.ts");
const { interceptToolCalls, extractToolCalls, handleToolCallExecution, buildWebSearchCallItem } =
  await import("../../src/lib/serverTools/interception.ts");
const { OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } =
  await import("../../open-sse/services/webSearchFallback.ts");

const originalWebSearch = builtinServerTools.web_search;

const executionContext = {
  apiKeyId: "key-a",
  sessionId: "session-1",
  requestId: "request-1",
  builtinToolNames: [OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME],
};

test.beforeEach(() => {
  builtinServerTools.web_search = async (input) => ({ record: `resolved:${input.id}` });
});

test.after(() => {
  builtinServerTools.web_search = originalWebSearch;
});

test("buildWebSearchCallItem emits a native web_search_call item only for successful web-search fallback results", () => {
  const call = { id: "call_search", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME, arguments: {} };
  const item = buildWebSearchCallItem(call, {
    success: true,
    provider: "serper-search",
    query: "latest omniroute release",
    results: [
      {
        title: "OmniRoute Docs",
        url: "https://example.com/omniroute",
        display_url: "example.com/omniroute",
        snippet: "The OmniRoute documentation",
      },
      { url: "https://example.com/no-title" },
      { title: "No URL", url: "" },
    ],
  });

  assert.equal(item?.type, "web_search_call");
  assert.equal(item?.status, "completed");
  assert.equal((item?.action as Record<string, unknown>).type, "web_search");
  assert.equal((item?.action as Record<string, unknown>).query, "latest omniroute release");
  const sources = (item?.action as Record<string, unknown>).sources as Array<
    Record<string, string>
  >;
  assert.deepEqual(sources, [
    {
      title: "OmniRoute Docs",
      url: "https://example.com/omniroute",
      caption: "The OmniRoute documentation",
    },
    { title: "https://example.com/no-title", url: "https://example.com/no-title", caption: "" },
  ]);

  // Non-search fallback calls never produce a web_search_call item.
  assert.equal(
    buildWebSearchCallItem(
      { id: "call-1", name: "lookup@1.0.0", arguments: {} },
      { success: true }
    ),
    null
  );
  // Failed searches keep the existing function_call_output error only.
  assert.equal(buildWebSearchCallItem(call, { success: false, error: "quota" }), null);
  assert.equal(buildWebSearchCallItem(call, null), null);
});

test("extractToolCalls supports OpenAI, Anthropic and Gemini shapes", () => {
  const openaiRoot = extractToolCalls(
    {
      tool_calls: [
        {
          id: "call-root",
          function: { name: "lookup@1.0.0", arguments: '{"id":"123"}' },
        },
      ],
    },
    "gpt-4.1"
  );
  const openaiChoices = extractToolCalls(
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-choice",
                function: { name: "lookup@1.0.0", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    },
    "openai-compatible-model"
  );
  const anthropic = extractToolCalls(
    {
      content: [
        { type: "text", text: "ignored" },
        { type: "tool_use", id: "claude-1", name: "lookup@1.0.0", input: { id: "abc" } },
      ],
    },
    "claude-sonnet"
  );
  const gemini = extractToolCalls(
    {
      functionCalls: [{ name: "lookup@1.0.0", args: { id: "gemini" } }],
    },
    "gemini-2.5-pro"
  );
  const responses = extractToolCalls(
    {
      object: "response",
      output: [
        {
          type: "function_call",
          call_id: "call-response",
          name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
          arguments: '{"query":"latest omniroute"}',
        },
      ],
    },
    "openai"
  );

  assert.deepEqual(openaiRoot, [
    {
      id: "call-root",
      name: "lookup@1.0.0",
      arguments: { id: "123" },
    },
  ]);
  assert.deepEqual(openaiChoices, [
    {
      id: "call-choice",
      name: "lookup@1.0.0",
      arguments: {},
    },
  ]);
  assert.deepEqual(anthropic, [
    {
      id: "claude-1",
      name: "lookup@1.0.0",
      arguments: { id: "abc" },
    },
  ]);
  assert.equal(gemini.length, 1);
  assert.equal(gemini[0].name, "lookup@1.0.0");
  assert.deepEqual(gemini[0].arguments, { id: "gemini" });
  assert.deepEqual(responses, [
    {
      id: "call-response",
      name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
      arguments: { query: "latest omniroute" },
    },
  ]);
  assert.deepEqual(extractToolCalls({}, "custom-model"), []);
});

test("interceptToolCalls returns outputs, execution errors and missing-tool errors", async () => {
  builtinServerTools.web_search = async (input) => {
    if (input.id === "bad") throw new Error("tool failure");
    return { record: `resolved:${input.id}` };
  };

  const results = await interceptToolCalls(
    [
      { id: "ok-call", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME, arguments: { id: "42" } },
      { id: "error-call", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME, arguments: { id: "bad" } },
      { id: "missing-call", name: "missing", arguments: {} },
    ],
    executionContext
  );

  assert.deepEqual(results, [
    { id: "ok-call", result: { record: "resolved:42" } },
    { id: "error-call", result: { error: "tool failure" } },
    { id: "missing-call", result: { error: "No handler for tool: missing" } },
  ]);
});

test("failed builtin outputs are sanitized before public tool results", async () => {
  const hostile =
    "builtin failed access_token=builtin-output-secret at /srv/private/builtin-output.ts\n" +
    "    at run (/srv/private/builtin-output.ts:9:4)";
  builtinServerTools.web_search = async () => ({
    success: false,
    status: 502,
    headers: { authorization: "Bearer builtin-output-secret" },
    body: hostile,
  });

  const results = await interceptToolCalls(
    [{ id: "builtin-failure", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME, arguments: {} }],
    executionContext
  );
  const serialized = JSON.stringify(results);

  assert.equal((results[0]?.result as Record<string, unknown>)?.status, 502);
  assert.doesNotMatch(
    serialized,
    /builtin-output-secret|srv\/private|builtin-output\.ts|\bat run\b/i
  );
});

test("a tool the request does not own is never executed", async () => {
  let called = false;
  builtinServerTools.web_search = async () => {
    called = true;
    return {};
  };

  const original = {
    content: [{ type: "tool_use", id: "t1", name: "web_search", input: {} }],
  };
  const result = await handleToolCallExecution(original, "claude-3-7-sonnet", {
    ...executionContext,
    builtinToolNames: [],
  });

  assert.equal(result, original);
  assert.equal(called, false);
});

test("handleToolCallExecution appends OpenAI tool results and leaves empty responses untouched", async () => {
  const openaiResponse = await handleToolCallExecution(
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-1",
                function: { name: "omniroute_web_search", arguments: '{"id":"99"}' },
              },
            ],
          },
        },
      ],
    },
    "gpt-4o-mini",
    executionContext
  );

  assert.deepEqual(openaiResponse.tool_results, [
    {
      tool_call_id: "call-1",
      output: '{"record":"resolved:99"}',
    },
  ]);

  const untouched = { choices: [{ message: { content: "plain text" } }] };
  assert.equal(await handleToolCallExecution(untouched, "gpt-4.1", executionContext), untouched);
});

test("handleToolCallExecution returns Anthropic tool results as text", async () => {
  const anthropicResponse = await handleToolCallExecution(
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tool-1", name: "omniroute_web_search", input: { id: "77" } },
      ],
    },
    "claude-3-7-sonnet",
    executionContext
  );

  assert.deepEqual(anthropicResponse.content, [
    {
      type: "text",
      text: '[Skill result: omniroute_web_search]\n{"record":"resolved:77"}',
    },
  ]);
  assert.equal(
    anthropicResponse.content.some((b: { type: string }) => b.type === "tool_result"),
    false
  );
  assert.equal(anthropicResponse.stop_reason, "end_turn");
  assert.equal(anthropicResponse.stop_sequence, null);
});

test("handleToolCallExecution appends Responses API function_call_output items", async () => {
  const responsesResult = await handleToolCallExecution(
    {
      object: "response",
      output: [
        {
          type: "function_call",
          call_id: "call-response",
          name: "omniroute_web_search",
          arguments: '{"id":"55"}',
        },
      ],
    },
    "openai",
    executionContext
  );

  assert.deepEqual(responsesResult.output, [
    {
      type: "function_call",
      call_id: "call-response",
      name: "omniroute_web_search",
      arguments: '{"id":"55"}',
    },
    {
      type: "function_call_output",
      call_id: "call-response",
      output: '{"record":"resolved:55"}',
    },
  ]);
});

test("handleToolCallExecution forwards unregistered client-native tool_use untouched (#2815)", async () => {
  const original = {
    content: [
      { type: "tool_use", id: "tool-native", name: "Bash", input: { command: "ls" } },
      { type: "text", text: "Calling Bash" },
    ],
  };
  const result = await handleToolCallExecution(original, "claude-3-7-sonnet", executionContext);

  assert.equal(result, original);
  assert.equal(
    (result.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    false
  );
});

test("handleToolCallExecution intercepts a server tool alongside an unregistered tool (#2815)", async () => {
  const mixed = await handleToolCallExecution(
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tool-native", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "tool-skill", name: "omniroute_web_search", input: { id: "9" } },
      ],
    },
    "claude-3-7-sonnet",
    executionContext
  );

  assert.deepEqual(mixed.content, [
    {
      type: "text",
      text: '[Skill result: omniroute_web_search]\n{"record":"resolved:9"}',
    },
    { type: "tool_use", id: "tool-native", name: "Bash", input: { command: "ls" } },
  ]);
  assert.equal(
    mixed.content.some((b: { type: string }) => b.type === "tool_result"),
    false
  );
  assert.equal(mixed.stop_reason, "tool_use");
});
