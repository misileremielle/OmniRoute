import test from "node:test";
import assert from "node:assert/strict";

// Local shape for formatter return values — avoids explicit any in assertions.
type FormattedResponse = {
  choices?: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  content?: Array<{ type: string; id?: string; text?: string }>;
  stop_reason?: string;
  stop_sequence?: string | null;
  output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
  response?: {
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
  };
};

const { builtinServerTools } = await import("../../src/lib/serverTools/builtins.ts");
const {
  classifyServerOwnedCalls,
  formatEscapeHatchResponse,
  executeServerOwned,
  ServerOwnedExecutionError,
} = await import("../../src/lib/serverTools/interception.ts");

const originalWebSearch = builtinServerTools.web_search;

test.beforeEach(() => {
  builtinServerTools.web_search = async () => ({ success: true });
});

test.after(() => {
  builtinServerTools.web_search = originalWebSearch;
});

// ─── Task 3: classifyServerOwnedCalls + formatEscapeHatchResponse RED tests ──

test("classifyServerOwnedCalls: owner set → serverOwned; everything else → clientNative", async () => {
  const calls = [
    { id: "c1", name: "web_search", arguments: {} },
    { id: "c3", name: "Bash", arguments: {} },
  ];

  const result = await classifyServerOwnedCalls(calls, {
    apiKeyId: "key-a",
    sessionId: "s1",
    requestId: "r1",
    builtinToolNames: ["web_search"],
  });

  assert.equal(result.serverOwned.length, 1);
  assert.equal(result.serverOwned[0].id, "c1");
  assert.equal(result.clientNative.length, 1);
  assert.equal(result.clientNative[0].id, "c3");
});

test("classifyServerOwnedCalls: client same-name tool → not server-owned", async () => {
  const calls = [
    { id: "c1", name: "client_search", arguments: {} },
    { id: "c2", name: "web_search", arguments: {} },
  ];

  const result = await classifyServerOwnedCalls(calls, {
    apiKeyId: "key-a",
    sessionId: "s1",
    requestId: "r1",
    builtinToolNames: ["web_search"],
    // client_search NOT in builtinToolNames (client owns it)
  });

  // client_search is client-native because it's not in any owner set.
  assert.equal(result.clientNative.length, 1);
  assert.equal(result.clientNative[0].id, "c1");
  assert.equal(result.serverOwned.length, 1);
  assert.equal(result.serverOwned[0].id, "c2");
});

test("formatEscapeHatchResponse: mixed OpenAI — strip server calls, append results to content, keep client calls, finish_reason:tool_calls", async () => {
  const response = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "srv1", function: { name: "web_search", arguments: "{}" } },
            { id: "cli1", function: { name: "Bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const serverCalls = [{ id: "srv1", name: "web_search", arguments: {} }];
  const clientCalls = [{ id: "cli1", name: "Bash", arguments: { cmd: "ls" } }];
  const results = [{ id: "srv1", name: "web_search", result: { status: 200 }, replayed: false }];

  const formatted = formatEscapeHatchResponse(
    response,
    serverCalls,
    results,
    clientCalls,
    "openai"
  );

  const choice = (formatted as FormattedResponse).choices[0];
  // Server call stripped from tool_calls, client call kept.
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].id, "cli1");
  // Server result appended to content.
  assert.ok(typeof choice.message.content === "string");
  assert.ok(choice.message.content.includes("200"));
  // finish_reason stays tool_calls (mixed).
  assert.equal(choice.finish_reason, "tool_calls");
});

test("formatEscapeHatchResponse: all-server OpenAI — strip tool calls, append results, finish_reason:stop", async () => {
  const response = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "srv1", function: { name: "web_search", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const serverCalls = [{ id: "srv1", name: "web_search", arguments: {} }];
  const results = [{ id: "srv1", name: "web_search", result: { ok: true }, replayed: false }];

  const formatted = formatEscapeHatchResponse(response, serverCalls, results, [], "openai");

  const choice = (formatted as FormattedResponse).choices[0];
  assert.ok(
    !choice.message.tool_calls || choice.message.tool_calls.length === 0,
    "all-server must have no remaining tool_calls"
  );
  assert.ok(typeof choice.message.content === "string");
  assert.ok(choice.message.content.includes("ok"));
  assert.equal(choice.finish_reason, "stop");
});

test("formatEscapeHatchResponse: Claude mixed — strip server tool_use, keep client tool_use, end_turn stays", async () => {
  const response = {
    content: [
      { type: "tool_use", id: "srv1", name: "web_search", input: {} },
      { type: "tool_use", id: "cli1", name: "Bash", input: { cmd: "ls" } },
    ],
    stop_reason: "tool_use",
  };

  const serverCalls = [{ id: "srv1", name: "web_search", arguments: {} }];
  const clientCalls = [{ id: "cli1", name: "Bash", arguments: { cmd: "ls" } }];
  const results = [{ id: "srv1", name: "web_search", result: { ok: true }, replayed: false }];

  const formatted = formatEscapeHatchResponse(
    response,
    serverCalls,
    results,
    clientCalls,
    "claude"
  );

  const content = (formatted as FormattedResponse).content as Array<{ type: string; id?: string }>;
  // Server tool_use removed, client tool_use kept.
  const toolUses = content.filter((b) => b.type === "tool_use");
  assert.equal(toolUses.length, 1);
  assert.equal(toolUses[0].id, "cli1");
  // stop_reason stays tool_use (mixed).
  assert.equal((formatted as FormattedResponse).stop_reason, "tool_use");
});

test("formatEscapeHatchResponse: Claude all-server — strip tool_use, append text, end_turn", async () => {
  const response = {
    content: [{ type: "tool_use", id: "srv1", name: "web_search", input: {} }],
    stop_reason: "tool_use",
  };

  const serverCalls = [{ id: "srv1", name: "web_search", arguments: {} }];
  const results = [{ id: "srv1", name: "web_search", result: { ok: true }, replayed: false }];

  const formatted = formatEscapeHatchResponse(response, serverCalls, results, [], "claude");

  const content = (formatted as FormattedResponse).content as Array<{ type: string }>;
  const toolUses = content.filter((b) => b.type === "tool_use");
  assert.equal(toolUses.length, 0);
  const textBlocks = content.filter((b) => b.type === "text");
  assert.ok(textBlocks.length > 0);
  assert.equal((formatted as FormattedResponse).stop_reason, "end_turn");
});

test("formatEscapeHatchResponse: formatter does not call interceptToolCalls or any handler (purity)", async () => {
  // Purity proof: the formatter is synchronous and its source must not contain
  // calls to interceptToolCalls, skillExecutor, or handler invocations.
  const fnSource = formatEscapeHatchResponse.toString();
  assert.ok(
    !fnSource.includes("interceptToolCalls"),
    "formatter source must not reference interceptToolCalls"
  );
  assert.ok(
    !fnSource.includes("skillExecutor"),
    "formatter source must not reference skillExecutor"
  );
  assert.ok(!fnSource.includes("await"), "formatter must be synchronous (no await)");

  // Also verify it returns immediately without side effects.
  const response = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "srv1", function: { name: "web_search", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const result = formatEscapeHatchResponse(
    response,
    [{ id: "srv1", name: "web_search", arguments: {} }],
    [{ id: "srv1", name: "web_search", result: { ok: true }, replayed: false }],
    [],
    "openai"
  );

  assert.ok(result, "formatter returns a result");
  assert.ok(result.choices[0].message.content, "formatter populates content");
});

test("formatEscapeHatchResponse: Responses wrapper is byte-identical for function_call_output", async () => {
  const response = {
    object: "response",
    output: [{ type: "function_call", call_id: "call1", name: "lookup@1.0.0", arguments: "{}" }],
  };

  const serverCalls = [{ id: "call1", name: "lookup@1.0.0", arguments: {} }];
  const results = [
    { id: "call1", name: "lookup@1.0.0", result: { record: "42" }, replayed: false },
  ];

  const formatted = formatEscapeHatchResponse(response, serverCalls, results, [], "openai");

  // Responses format: original output + function_call_output appended.
  const output = (formatted as FormattedResponse).output;
  assert.equal(output.length, 2);
  assert.equal(output[0].type, "function_call");
  assert.equal(output[1].type, "function_call_output");
  assert.equal(output[1].call_id, "call1");
});

// ─── F3: nested Responses output formatter ──────────────────────────────────

test("formatEscapeHatchResponse: nested {response:{output}} appends function_call_output to nested output, not top-level", async () => {
  const nestedResponse = {
    object: "response",
    response: {
      output: [{ type: "function_call", call_id: "nc1", name: "lookup@1.0.0", arguments: "{}" }],
    },
  };

  const serverCalls = [{ id: "nc1", name: "lookup@1.0.0", arguments: {} }];
  const results = [
    { id: "nc1", name: "lookup@1.0.0", result: { record: "nested-42" }, replayed: false },
  ];

  const formatted = formatEscapeHatchResponse(nestedResponse, serverCalls, results, [], "openai");

  // Must append to nested response.output, not top-level output.
  const nestedOutput = (formatted as { response?: { output?: unknown[] } }).response?.output;
  assert.ok(Array.isArray(nestedOutput), "nested response.output must be an array");
  assert.equal(nestedOutput.length, 2, "nested output must have original + appended");
  assert.equal(nestedOutput[0].type, "function_call");
  assert.equal(nestedOutput[1].type, "function_call_output");
  assert.equal((nestedOutput[1] as { call_id: string }).call_id, "nc1");

  // Top-level must NOT have an output array.
  assert.equal(
    Array.isArray((formatted as { output?: unknown[] }).output),
    false,
    "top-level output must not exist"
  );
});

// ─── F1: executeServerOwned RED tests ───────────────────────────────────────

test("executeServerOwned: requires requestIdentity when executionFenceEnabled", async () => {
  const calls = [{ id: "c1", name: "web_search", arguments: { url: "https://example.com" } }];
  const context = {
    apiKeyId: "key-fence",
    sessionId: "s1",
    requestId: "r1",
    builtinToolNames: ["web_search"],
    executionFenceEnabled: true,
    // requestIdentity is deliberately missing
  };

  await assert.rejects(
    () => executeServerOwned(calls, context),
    /requestIdentity/,
    "must require requestIdentity when executionFenceEnabled"
  );
});

test("executeServerOwned: dispatches a builtin tool", async () => {
  const calls = [{ id: "c1", name: "web_search", arguments: { url: "https://example.com" } }];
  const context = {
    apiKeyId: "key-builtin",
    sessionId: "s1",
    requestId: "r1",
    builtinToolNames: ["web_search"],
    executionFenceEnabled: false,
  };

  const results = await executeServerOwned(calls, context);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "c1");
  assert.equal(results[0].name, "web_search");
  assert.equal(results[0].replayed, false);
});

test("executeServerOwned: surfaces identity_conflict as typed error, never feeds to model", async () => {
  // Custom skill call with no matching handler — should surface as error
  const calls = [{ id: "c1", name: "missing-skill@1.0.0", arguments: {} }];
  const context = {
    apiKeyId: "key-err",
    sessionId: "s1",
    requestId: "r1",
    executionFenceEnabled: false,
  };

  const results = await executeServerOwned(calls, context);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "c1");
  assert.equal(results[0].replayed, false);
  // Result must contain an error indicator
  const resultRecord = results[0].result as Record<string, unknown>;
  assert.ok(
    resultRecord && (resultRecord.error || resultRecord.status),
    "result must contain error indicator"
  );
});

// ─── Fix Round 2: Defect 1 — typed errors for fence control-flow states ────

test("ServerOwnedExecutionError is an exported class with code and httpStatus", () => {
  const err = new ServerOwnedExecutionError("test", "TEST_CODE", 409);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "TEST_CODE");
  assert.equal(err.httpStatus, 409);
  assert.equal(err.message, "test");
});

test("executeServerOwned: in_progress fence state → throws ServerOwnedExecutionError with TOOL_IN_PROGRESS (409)", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({ kind: "in_progress" as const });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "TOOL_IN_PROGRESS");
      assert.equal(e.httpStatus, 409);
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

test("executeServerOwned: unknown fence state → throws ServerOwnedExecutionError with TOOL_STATE_UNKNOWN (500)", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({ kind: "unknown" as const });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "TOOL_STATE_UNKNOWN");
      assert.equal(e.httpStatus, 500);
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

test("executeServerOwned: identity_conflict fence state → throws ServerOwnedExecutionError with IDENTITY_CONFLICT (409)", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({ kind: "identity_conflict" as const });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "IDENTITY_CONFLICT");
      assert.equal(e.httpStatus, 409);
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

// ─── Fix Round 3: Defect 1 — replay error/timeout detection ───────────────

test("executeServerOwned: error replay → throws ServerOwnedExecutionError with TOOL_EXECUTION_ERROR (500)", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({
    kind: "replayed" as const,
    value: null,
    status: "error" as const,
    errorMessage: "handler crashed",
  });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "TOOL_EXECUTION_ERROR");
      assert.equal(e.httpStatus, 500);
      assert.equal(e.message, "handler crashed");
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

test("executeServerOwned: timeout replay → throws ServerOwnedExecutionError with TOOL_EXECUTION_TIMEOUT (504)", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({
    kind: "replayed" as const,
    value: null,
    status: "timeout" as const,
    errorMessage: "execution exceeded deadline",
  });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "TOOL_EXECUTION_TIMEOUT");
      assert.equal(e.httpStatus, 504);
      assert.equal(e.message, "execution exceeded deadline");
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

test("executeServerOwned: success replay → returns ExecutedToolResult with replayed:true", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({
    kind: "replayed" as const,
    value: { cached: true },
    status: "success" as const,
    errorMessage: null,
  });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    const results = await executeServerOwned(calls, context);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "c1");
    assert.equal(results[0].replayed, true);
    assert.deepEqual(results[0].result, { cached: true });
  } finally {
    setFenceFnForTesting(null);
  }
});

test("executeServerOwned: error replay with null errorMessage → uses default message", async () => {
  const { setFenceFnForTesting } = await import("../../src/lib/serverTools/interception.ts");
  const mockFence = async () => ({
    kind: "replayed" as const,
    value: null,
    status: "error" as const,
    errorMessage: null,
  });
  setFenceFnForTesting(mockFence);

  try {
    const calls = [{ id: "c1", name: "web_search", arguments: {} }];
    const context = {
      apiKeyId: "key-fence",
      sessionId: "s1",
      requestId: "r1",
      builtinToolNames: ["web_search"],
      executionFenceEnabled: true,
      requestIdentity: "identity-1",
    };

    try {
      await executeServerOwned(calls, context);
      assert.fail("must throw");
    } catch (e: unknown) {
      assert.ok(e instanceof ServerOwnedExecutionError);
      assert.equal(e.code, "TOOL_EXECUTION_ERROR");
      assert.equal(e.message, "Tool execution failed");
    }
  } finally {
    setFenceFnForTesting(null);
  }
});

// ─── Fix Round 2: Defect 2 — executeClaimed non-success throws ──────────────

test("LEASE_DURATION_MS is 120000 to match loop wall-clock upper bound", async () => {
  const fs = await import("node:fs");
  const sourceCode = fs.readFileSync(
    new URL("../../src/lib/serverTools/interception.ts", import.meta.url),
    "utf8"
  );
  const match = sourceCode.match(/const\s+LEASE_DURATION_MS\s*=\s*([\d_]+)/);
  assert.ok(match, "LEASE_DURATION_MS must be defined in interception.ts");
  const value = Number(match[1].replace(/_/g, ""));
  assert.equal(value, 120_000, "LEASE_DURATION_MS must be 120000 (not 30000)");
});
