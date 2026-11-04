import { projectToolOutputForBoundary } from "./outputProjection";
import { builtinServerTools } from "./builtins";
import { OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } from "@omniroute/open-sse/services/webSearchFallback.ts";
import { OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME } from "@omniroute/open-sse/services/webFetchInterception.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { runWithServerToolFence } from "./toolExecutionFence";
import type { ExecutedToolResult, ToolCall, ExecutionContext } from "./toolLoopTypes";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("SERVER_TOOL_INTERCEPTION");

function detectProvider(modelId: string): "openai" | "anthropic" | "google" | "other" {
  const lower = modelId.toLowerCase();

  if (lower.includes("gpt") || lower.includes("openai")) {
    return "openai";
  }
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return "anthropic";
  }
  if (lower.includes("gemini") || lower.includes("google")) {
    return "google";
  }

  return "other";
}

/**
 * Typed error for server-owned tool execution control-flow states
 * (in_progress, unknown, identity_conflict). These must never be fed
 * back to the model as tool results — they represent infrastructure
 * conditions that should surface as HTTP-level errors.
 */
export class ServerOwnedExecutionError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = "ServerOwnedExecutionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function toSafeToolErrorMessage(value: unknown): string {
  try {
    const raw = value instanceof Error ? value.message : value;
    return sanitizeErrorMessage(raw) || "Tool execution failed";
  } catch {
    return "Tool execution failed";
  }
}

function projectToolResultForPublicResponse(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return projectToolOutputForBoundary(result as Record<string, unknown>);
}

// ToolCall and ExecutionContext types are imported from ./toolLoopTypes.ts

const BUILTIN_TOOL_ALIASES: Record<string, string> = {
  [OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME]: "web_search",
  [OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME]: "web_fetch",
};

function resolveBuiltinHandlerName(toolName: string, context: ExecutionContext): string | null {
  const [rawName] = toolName.includes("@") ? toolName.split("@") : [toolName];
  const canonicalName = BUILTIN_TOOL_ALIASES[rawName] || rawName;
  const allowed = new Set(
    (context.builtinToolNames || []).map((name) => BUILTIN_TOOL_ALIASES[name] || name)
  );

  if (!allowed.has(canonicalName)) {
    return null;
  }

  return canonicalName in builtinServerTools ? canonicalName : null;
}

function getResponsesOutputContainer(response: Record<string, unknown> | null | undefined): {
  root: Record<string, unknown>;
  responseRoot: Record<string, unknown>;
  output: unknown[];
} | null {
  if (!response || typeof response !== "object") return null;

  if (Array.isArray(response.output)) {
    return {
      root: response,
      responseRoot: response,
      output: response.output,
    };
  }

  if (
    response.response &&
    typeof response.response === "object" &&
    !Array.isArray(response.response) &&
    Array.isArray((response.response as Record<string, unknown>).output)
  ) {
    return {
      root: response,
      responseRoot: response.response as Record<string, unknown>,
      output: (response.response as Record<string, unknown>).output as unknown[],
    };
  }

  return null;
}

export async function interceptToolCalls(
  toolCalls: ToolCall[],
  context: ExecutionContext
): Promise<{ id: string; result: unknown }[]> {
  const results = await Promise.all(
    toolCalls.map(async (call) => {
      try {
        const builtinHandlerName = resolveBuiltinHandlerName(call.name, context);
        if (!builtinHandlerName) {
          throw new Error(`No handler for tool: ${call.name}`);
        }
        log.info("server_tools.interception.builtin_tool_detected", {
          toolName: call.name,
          builtinHandler: builtinHandlerName,
          callId: call.id,
        });

        const result = await builtinServerTools[builtinHandlerName](call.arguments, {
          apiKeyId: context.apiKeyId,
          sessionId: context.sessionId,
          provider: context.provider,
          model: context.model,
        });

        log.info("server_tools.interception.execution_complete", {
          toolName: call.name,
          callId: call.id,
        });

        return {
          id: call.id,
          result: projectToolResultForPublicResponse(result),
        };
      } catch (err) {
        const safeError = toSafeToolErrorMessage(err);
        log.error("skills.interception.execution_failed", {
          toolName: call.name,
          callId: call.id,
          err: safeError,
        });
        return {
          id: call.id,
          result: { error: safeError },
        };
      }
    })
  );

  return results;
}

export function extractToolCalls(response: any, modelIdOrSourceFormat: string): ToolCall[] {
  // Accept either a sourceFormat ("openai" | "claude") or a model ID string.
  // Map known sourceFormat values; fall back to detectProvider for model IDs.
  const format =
    modelIdOrSourceFormat === "openai" || modelIdOrSourceFormat === "claude"
      ? modelIdOrSourceFormat
      : undefined;
  const provider =
    format === "claude"
      ? "anthropic"
      : format === "openai"
        ? "openai"
        : detectProvider(modelIdOrSourceFormat);

  switch (provider) {
    case "openai": {
      const rootToolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
      const choiceToolCalls = Array.isArray(response?.choices)
        ? response.choices.flatMap((choice: any) =>
            Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
          )
        : [];
      const responsesOutput = getResponsesOutputContainer(response);
      const responsesToolCalls = responsesOutput
        ? responsesOutput.output
            .map((item: unknown) => (item && typeof item === "object" ? (item as any) : null))
            .filter((item: any) => item?.type === "function_call")
        : [];
      const toolCalls =
        rootToolCalls.length > 0
          ? rootToolCalls
          : choiceToolCalls.length > 0
            ? choiceToolCalls
            : responsesToolCalls;

      return toolCalls.map((tc: any) => ({
        id: tc.call_id || tc.id || `call_${Date.now()}`,
        name: tc.function?.name || tc.name || "",
        arguments: parseArguments(tc.function?.arguments || tc.arguments || "{}"),
      }));
    }

    case "anthropic":
      return (response.content || [])
        .filter((c: any) => c.type === "tool_use")
        .map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.input || {},
        }));

    case "google":
      return (response.functionCalls || []).map((fc: any) => ({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: fc.name,
        arguments: fc.args || {},
      }));

    default:
      return [];
  }
}

function parseArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args === "object") {
    return args;
  }

  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * Build a native Responses API `web_search_call` output item from an executed
 * web-search fallback call. OpenAI Responses clients (Codex CLI, pi-web-access,
 * …) send the built-in `web_search` tool and expect the response to carry a
 * `web_search_call` item with `action.sources`; without it they only receive the
 * internal `function_call`/`function_call_output` round-trip and cannot consume
 * the search results. Returns null when the call was not the web-search
 * fallback, or when the search failed / returned no usable result payload.
 */
export function buildWebSearchCallItem(
  call: ToolCall,
  result: unknown
): Record<string, unknown> | null {
  if (call.name !== OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME) return null;
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!record || record.success !== true) return null;

  const results = Array.isArray(record.results) ? record.results : [];
  const sources = results
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      const url = typeof source.url === "string" ? source.url : "";
      if (!url) return null;
      const title = typeof source.title === "string" ? source.title : url;
      const caption =
        typeof source.snippet === "string" && source.snippet
          ? source.snippet
          : typeof source.display_url === "string"
            ? source.display_url
            : "";
      return { title, url, caption };
    })
    .filter((source): source is { title: string; url: string; caption: string } => source !== null);

  return {
    id: `ws_${call.id}`,
    type: "web_search_call",
    status: "completed",
    action: {
      type: "web_search",
      query: typeof record.query === "string" ? record.query : "",
      sources,
    },
  };
}

export async function handleToolCallExecution(
  response: any,
  modelId: string,
  context: ExecutionContext
): Promise<any> {
  // Only intercept tool_use blocks that resolve to a builtin handler. Unknown tool names
  // are forwarded untouched so client-native tools (Bash, Read, etc.) are not turned into
  // tool_result blocks appended back into the assistant response. See #2815.
  const toolCalls = extractToolCalls(response, modelId).filter(
    (call) =>
      typeof call?.name === "string" &&
      Boolean(call.name) &&
      resolveBuiltinHandlerName(call.name, context) !== null
  );

  if (toolCalls.length === 0) {
    return response;
  }

  const results = await interceptToolCalls(toolCalls, context);

  const provider = detectProvider(modelId);

  switch (provider) {
    case "openai": {
      const responsesOutput = getResponsesOutputContainer(response);
      if (responsesOutput) {
        const functionOutputs = results.map((result) => ({
          type: "function_call_output",
          call_id: result.id,
          output: JSON.stringify(result.result),
        }));

        // OpenAI Responses clients that declared the native `web_search` tool get
        // a spec-shaped `web_search_call` item alongside the preserved internal
        // function-call round-trip, so their own web-search handling can consume
        // the executed results (pi-web-access / Codex-style consumers).
        const resultById = new Map(results.map((r) => [r.id, r.result]));
        const webSearchCalls = toolCalls
          .map((call) => buildWebSearchCallItem(call, resultById.get(call.id)))
          .filter((item): item is Record<string, unknown> => item !== null);

        if (responsesOutput.root === responsesOutput.responseRoot) {
          return {
            ...response,
            output: [...responsesOutput.output, ...functionOutputs, ...webSearchCalls],
          };
        }

        return {
          ...response,
          response: {
            ...responsesOutput.responseRoot,
            output: [...responsesOutput.output, ...functionOutputs, ...webSearchCalls],
          },
        };
      }

      return {
        ...response,
        tool_results: results.map((r) => ({
          tool_call_id: r.id,
          output: JSON.stringify(r.result),
        })),
      };
    }

    case "anthropic": {
      // Anthropic only permits tool_result blocks in user messages. This helper
      // returns a single assistant response, so there is no valid place to put a
      // server-side skill result as tool_result here. Keep client-native tool_use
      // blocks untouched, remove the OmniRoute-handled tool_use blocks, and expose
      // their results as plain assistant text instead of corrupting history with
      // assistant-side tool_result blocks. See #2815.
      //
      // When no client-native tool_use blocks remain (all were handled here), the
      // upstream stop_reason "tool_use" is stale and would make clients wait for
      // tool_use blocks that no longer exist — so it is normalized to "end_turn"
      // (with stop_sequence cleared). The mixed-tool branch keeps the original
      // stop_reason because real native tool_use blocks still need the client.
      const handledToolCallIds = new Set(results.map((r) => r.id));
      const toolNamesById = new Map(toolCalls.map((call) => [call.id, call.name]));
      const remainingContent = (Array.isArray(response.content) ? response.content : []).filter(
        (block: any) => !(block?.type === "tool_use" && handledToolCallIds.has(block.id))
      );
      const resultTextBlocks = results.map((r) => ({
        type: "text",
        text: `[Skill result: ${toolNamesById.get(r.id) || r.id}]\n${JSON.stringify(r.result)}`,
      }));
      const firstRemainingToolUseIndex = remainingContent.findIndex(
        (block: any) => block?.type === "tool_use"
      );

      if (firstRemainingToolUseIndex === -1) {
        return {
          ...response,
          content: [...remainingContent, ...resultTextBlocks],
          stop_reason: "end_turn",
          stop_sequence: null,
        };
      }

      return {
        ...response,
        content: [
          ...remainingContent.slice(0, firstRemainingToolUseIndex),
          ...resultTextBlocks,
          ...remainingContent.slice(firstRemainingToolUseIndex),
        ],
      };
    }

    default:
      return response;
  }
}

// ─── Task 3: ownership classifier ────────────────────────────────────────────

export async function classifyServerOwnedCalls(
  toolCalls: ToolCall[],
  context: ExecutionContext
): Promise<{ serverOwned: ToolCall[]; clientNative: ToolCall[] }> {
  const builtinSet = new Set(context.builtinToolNames || []);

  const serverOwned: ToolCall[] = [];
  const clientNative: ToolCall[] = [];

  for (const call of toolCalls) {
    if (builtinSet.has(call.name)) {
      serverOwned.push(call);
    } else {
      clientNative.push(call);
    }
  }

  return { serverOwned, clientNative };
}

// ─── Task 3: executeServerOwned — fence-gated execution callback ────────────

const LEASE_DURATION_MS = 120_000;

/**
 * Runtime seam: overridable fence function for testing.
 * When null, the real `runWithServerToolFence` is used.
 * Tests may set this to inject controlled fence outcomes.
 */
let _fenceFn: typeof runWithServerToolFence | null = null;

export function setFenceFnForTesting(fn: typeof runWithServerToolFence | null): void {
  _fenceFn = fn;
}

export async function executeServerOwned(
  calls: ToolCall[],
  context: ExecutionContext,
  fenceFn?: typeof runWithServerToolFence
): Promise<ExecutedToolResult[]> {
  if (context.executionFenceEnabled && !context.requestIdentity) {
    throw new Error(
      "executeServerOwned requires context.requestIdentity when executionFenceEnabled is true"
    );
  }

  const results: ExecutedToolResult[] = [];

  for (const call of calls) {
    const builtinHandlerName = resolveBuiltinHandlerName(call.name, context);

    const executeFn = async (): Promise<unknown> => {
      if (builtinHandlerName) {
        return builtinServerTools[builtinHandlerName](call.arguments, {
          apiKeyId: context.apiKeyId,
          sessionId: context.sessionId,
          provider: context.provider,
          model: context.model,
        });
      }
      throw new Error(`No handler for tool: ${call.name}`);
    };

    if (context.executionFenceEnabled && context.requestIdentity) {
      const activeFenceFn = fenceFn ?? _fenceFn ?? runWithServerToolFence;
      const fenceResult = await activeFenceFn({
        apiKeyId: context.apiKeyId,
        requestIdentity: context.requestIdentity,
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        leaseDurationMs: LEASE_DURATION_MS,
        execute: executeFn,
      });

      switch (fenceResult.kind) {
        case "executed":
          results.push({
            id: call.id,
            name: call.name,
            result: projectToolResultForPublicResponse(fenceResult.value),
            replayed: false,
          });
          break;
        case "replayed": {
          if (fenceResult.status === "error") {
            throw new ServerOwnedExecutionError(
              fenceResult.errorMessage ?? "Tool execution failed",
              "TOOL_EXECUTION_ERROR",
              500
            );
          }
          if (fenceResult.status === "timeout") {
            throw new ServerOwnedExecutionError(
              fenceResult.errorMessage ?? "Tool execution timed out",
              "TOOL_EXECUTION_TIMEOUT",
              504
            );
          }
          results.push({
            id: call.id,
            name: call.name,
            result: projectToolResultForPublicResponse(fenceResult.value),
            replayed: true,
          });
          break;
        }
        case "in_progress":
          throw new ServerOwnedExecutionError(
            "Tool execution in progress",
            "TOOL_IN_PROGRESS",
            409
          );
        case "unknown":
          throw new ServerOwnedExecutionError(
            "Tool execution state unknown",
            "TOOL_STATE_UNKNOWN",
            500
          );
        case "identity_conflict":
          throw new ServerOwnedExecutionError(
            "Tool execution identity conflict",
            "IDENTITY_CONFLICT",
            409
          );
      }
    } else {
      // Flag-off path: no fence, dispatch directly.
      try {
        const value = await executeFn();
        results.push({
          id: call.id,
          name: call.name,
          result: projectToolResultForPublicResponse(value),
          replayed: false,
        });
      } catch (err) {
        results.push({
          id: call.id,
          name: call.name,
          result: { error: toSafeToolErrorMessage(err) },
          replayed: false,
        });
      }
    }
  }

  return results;
}

// ─── Task 3: pure escape formatter ───────────────────────────────────────────

function extractOpenAIToolCalls(
  response: Record<string, unknown>
): Array<{ id: string; function: { name: string; arguments: string } }> {
  const rootToolCalls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
  const choiceToolCalls = Array.isArray(response.choices)
    ? (response.choices as any[]).flatMap((choice: any) =>
        Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
      )
    : [];
  return rootToolCalls.length > 0 ? rootToolCalls : choiceToolCalls;
}

function getOpenAIResponseOutput(
  response: Record<string, unknown>
): { target: Record<string, unknown>; output: unknown[] } | null {
  if (Array.isArray(response.output)) {
    return { target: response, output: response.output };
  }
  if (
    response.response &&
    typeof response.response === "object" &&
    !Array.isArray(response.response) &&
    Array.isArray((response.response as Record<string, unknown>).output)
  ) {
    return {
      target: response.response as Record<string, unknown>,
      output: (response.response as Record<string, unknown>).output as unknown[],
    };
  }
  return null;
}

export function formatEscapeHatchResponse(
  response: Record<string, unknown>,
  serverCalls: ToolCall[],
  results: ExecutedToolResult[],
  clientCalls: ToolCall[],
  sourceFormat: "openai" | "claude",
  serializedResultTextById?: Map<string, string>
): Record<string, unknown> {
  const serverIds = new Set(serverCalls.map((c) => c.id));

  if (sourceFormat === "openai") {
    // Check for Responses API format.
    const responsesOutput = getOpenAIResponseOutput(response);
    if (responsesOutput) {
      // For Responses, append function_call_output for server calls.
      const functionOutputs = results
        .filter((r) => serverIds.has(r.id))
        .map((r) => ({
          type: "function_call_output",
          call_id: r.id,
          output: serializedResultTextById?.get(r.id) ?? JSON.stringify(r.result),
        }));
      return {
        ...response,
        response:
          responsesOutput.target !== response
            ? {
                ...(response.response as Record<string, unknown>),
                output: [...responsesOutput.output, ...functionOutputs],
              }
            : undefined,
        output:
          responsesOutput.target === response
            ? [...responsesOutput.output, ...functionOutputs]
            : response.output,
      };
    }

    // Chat Completions format.
    const originalToolCalls = extractOpenAIToolCalls(response);
    const remainingToolCalls = originalToolCalls.filter(
      (tc: any) => !serverIds.has(tc.id || tc.call_id)
    );

    // Build result text from server results.
    const resultTexts = results
      .filter((r) => serverIds.has(r.id))
      .map(
        (r) =>
          `[${r.name} result]\n${serializedResultTextById?.get(r.id) ?? JSON.stringify(r.result)}`
      )
      .join("\n\n");

    const existingContent =
      typeof response.choices?.[0]?.message?.content === "string"
        ? response.choices[0].message.content
        : "";
    const newContent = existingContent ? `${existingContent}\n\n${resultTexts}` : resultTexts;

    // Clone response to avoid mutation.
    const formatted = JSON.parse(JSON.stringify(response));
    if (formatted.choices?.[0]?.message) {
      formatted.choices[0].message.content = newContent;
      formatted.choices[0].message.tool_calls =
        remainingToolCalls.length > 0 ? remainingToolCalls : undefined;
    }

    // Mixed → keep tool_calls finish_reason; all-server → stop.
    if (remainingToolCalls.length === 0 && clientCalls.length === 0) {
      formatted.choices[0].finish_reason = "stop";
    }

    return formatted;
  }

  if (sourceFormat === "claude") {
    const remainingContent = (Array.isArray(response.content) ? response.content : []).filter(
      (block: any) => !(block?.type === "tool_use" && serverIds.has(block.id))
    );

    // Build result text blocks.
    const resultTextBlocks = results
      .filter((r) => serverIds.has(r.id))
      .map((r) => ({
        type: "text",
        text: `[${r.name} result]\n${serializedResultTextById?.get(r.id) ?? JSON.stringify(r.result)}`,
      }));

    // Insert result text blocks before the first remaining tool_use.
    const firstRemainingIndex = remainingContent.findIndex(
      (block: any) => block?.type === "tool_use"
    );

    let newContent: unknown[];
    if (firstRemainingIndex === -1) {
      newContent = [...remainingContent, ...resultTextBlocks];
    } else {
      newContent = [
        ...remainingContent.slice(0, firstRemainingIndex),
        ...resultTextBlocks,
        ...remainingContent.slice(firstRemainingIndex),
      ];
    }

    const formatted: Record<string, unknown> = { ...response, content: newContent };

    // All-server → end_turn; mixed → keep original stop_reason.
    const remainingToolUseCount = remainingContent.filter(
      (b: any) => b?.type === "tool_use"
    ).length;
    if (remainingToolUseCount === 0 && clientCalls.length === 0) {
      formatted.stop_reason = "end_turn";
      formatted.stop_sequence = null;
    }

    return formatted;
  }

  return response;
}
