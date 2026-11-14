// @ts-nocheck
// #13789 — built-in OpenAI-format providers forward non-function tool types unchanged.
//
// normalizeOpenAICompatibleTools() only ran for custom `openai-compatible-*` providers,
// so a built-in provider like agentrouter (OpenAI Chat wire) forwarded client tools such
// as `{ type: "web_search" }` verbatim and the GLM backend rejected the WHOLE request
// with `400 tools[0].type:type is illegal`. The fix extends the normalization to a
// conservative allowlist of built-in providers observed to accept function tools only,
// gated on the OpenAI Chat target format. OpenAI itself is NOT on the list, so its
// `custom` tools keep passing through untouched (acceptance criterion 2).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-13789-nonfunction-tools-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const originalFetch = globalThis.fetch;

function noopLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function chatCompletionResponse(model) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_13789",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function flushAsyncSideEffects() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await flushAsyncSideEffects();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function runChatRequest({ provider, model, apiKey, tools }) {
  let captured = null;
  globalThis.fetch = async (url, init = {}) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init.body || "{}")),
    };
    return chatCompletionResponse(model);
  };

  const body = {
    model: `${provider}/${model}`,
    messages: [{ role: "user", content: "Reply with exactly OK" }],
    max_tokens: 16,
    stream: false,
    tools,
  };
  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider, model, extendedContext: false },
    credentials: { apiKey, providerSpecificData: {} },
    log: noopLog(),
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: structuredClone(body),
      headers: new Headers({ accept: "application/json" }),
    },
    userAgent: "test-client/1.0",
  });
  return { result, captured };
}

test("#13789 openai: `custom` tools stay untouched (allowlist is conservative)", async () => {
  const customTool = {
    type: "custom",
    name: "exec",
    format: { type: "grammar", grammar: "lark" },
  };
  const { result, captured } = await runChatRequest({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "test-openai-key",
    tools: [customTool],
  });

  assert.equal(result.success, true);
  assert.ok(captured, "the executor was reached");
  const tools = captured.body.tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "custom", "openai keeps its own custom tool type");
  assert.equal(tools[0].name, "exec");
});
