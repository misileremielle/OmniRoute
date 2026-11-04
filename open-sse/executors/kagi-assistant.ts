/**
 * KagiAssistantExecutor — chat through a Kagi subscription (assistant.kagi.com).
 *
 * Kagi publishes no Assistant API; this follows the web client's private v2 API
 * the same way kagi-cli does (github.com/Microck/kagi-cli, MIT), so it can break
 * when Kagi changes it:
 *
 *   POST /api/v2/conversations          { content, model } -> { assistant_turn_uuid }
 *   GET  /api/v2/turns/<uuid>/stream    SSE of { event: { type, node_id, payload } }
 *
 * Auth: the `kagi_session` cookie, from the token in the account's Session Link.
 * Every request starts a new conversation, so the OpenAI message history is folded
 * into one prompt, and each request appears as a thread in the Kagi history.
 */
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import {
  makeExecutorErrorResult as makeErrorResult,
  sanitizeErrorMessage,
} from "../utils/error.ts";

export const KAGI_ASSISTANT_URL = "https://assistant.kagi.com";
const CONVERSATIONS_URL = `${KAGI_ASSISTANT_URL}/api/v2/conversations`;

/** Accepts the raw token, `kagi_session=...`, a Cookie header, or the Session Link URL. */
export function normalizeKagiSessionToken(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().replace(/^Cookie:\s*/i, "") : "";
  const match = value.match(/(?:[?&]token=|(?:^|;\s*)kagi_session=)([^&;\s]+)/);
  return match ? match[1] : value;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = part as { type?: unknown; text?: unknown };
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  developer: "System",
  assistant: "Assistant",
  tool: "Tool",
};

/** One prompt from the chat history; a lone user message passes through unchanged. */
export function buildKagiPrompt(messages: unknown): string {
  const turns = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const record = message as { role?: unknown; content?: unknown };
      return { role: String(record?.role ?? "user"), text: textOf(record?.content).trim() };
    })
    .filter((turn) => turn.text);
  if (turns.length === 1 && turns[0].role === "user") return turns[0].text;
  return turns.map((turn) => `${ROLE_LABELS[turn.role] ?? "User"}: ${turn.text}`).join("\n\n");
}

export type KagiTurnEvent =
  | { kind: "content" | "reasoning"; text: string }
  | { kind: "done"; usage: { prompt_tokens: number; completion_tokens: number } | null }
  | { kind: "error"; message: string };

type TurnFrame = {
  error?: unknown;
  event?: { type?: string; node_id?: string; payload?: Record<string, unknown> };
};

/**
 * Turns Kagi stream frames into text events. Answer text arrives on `kind: "text"`
 * nodes and reasoning on `kind: "thinking"` nodes; other nodes (tool calls) are
 * skipped. Citation markers `[^ref_id]` become numbered `[^N]`, listed at the end.
 */
export class KagiTurnParser {
  private nodeKinds = new Map<string, string>();
  private lastTextNode: string | null = null;
  private references = new Map<string, Record<string, unknown>>();
  private cited: string[] = [];
  private pending = "";
  private started = false;

  private renderCitations(final: boolean): string {
    let output = "";
    let position = 0;
    const text = this.pending;
    for (;;) {
      const start = text.indexOf("[^", position);
      if (start < 0) break;
      output += text.slice(position, start);
      position = start;
      const close = text.indexOf("]", start);
      if (close < 0) {
        if (final) break;
        this.pending = text.slice(start); // marker may finish in the next delta
        return output;
      }
      const marker = text.slice(start, close + 1);
      const refId = marker.slice(2, -1).split("#")[0];
      if (this.references.has(refId)) {
        if (!this.cited.includes(refId)) this.cited.push(refId);
        output += `[^${this.cited.indexOf(refId) + 1}]`;
      } else {
        output += marker;
      }
      position = close + 1;
    }
    output += text.slice(position);
    this.pending = "";
    return output;
  }

  private referenceList(): string {
    const lines = this.cited.map((refId, index) => {
      const reference = this.references.get(refId) ?? {};
      const title = String(reference.title ?? reference.url ?? refId);
      return `[^${index + 1}]: ${reference.url ? `[${title}](${String(reference.url)})` : title}`;
    });
    return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
  }

  parseFrame(frame: string): KagiTurnEvent[] {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    let parsed: TurnFrame;
    try {
      parsed = JSON.parse(data) as TurnFrame;
    } catch {
      return [{ kind: "error", message: "Kagi Assistant sent an unreadable stream frame" }];
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return [{ kind: "error", message: sanitizeErrorMessage(parsed.error) }];
    }
    const event = parsed.event;
    const payload = event?.payload ?? {};
    switch (event?.type) {
      case "node.created":
        if (event.node_id) this.nodeKinds.set(event.node_id, String(payload.kind ?? ""));
        return [];
      case "reference.added":
        if (typeof payload.ref_id === "string") this.references.set(payload.ref_id, payload);
        return [];
      case "node.delta":
        return this.parseDelta(event.node_id, payload.delta);
      case "turn.completed":
        return this.parseCompleted(payload);
      case "turn.failed":
      case "turn.cancelled":
        return [
          {
            kind: "error",
            message: `Kagi Assistant turn ${event.type.slice(5)}: ${sanitizeErrorMessage(
              String(payload.error_code ?? "unknown error")
            )}`,
          },
        ];
      default:
        return [];
    }
  }

  private parseDelta(nodeId: string | undefined, delta: unknown): KagiTurnEvent[] {
    if (!nodeId || typeof delta !== "string") return [];
    const kind = this.nodeKinds.get(nodeId);
    if (kind === "thinking") return delta ? [{ kind: "reasoning", text: delta }] : [];
    if (kind !== "text") return [];
    if (this.started && this.lastTextNode !== nodeId) this.pending += "\n\n";
    this.pending += this.started ? delta : delta.trimStart(); // some models lead with a space
    this.started ||= this.pending.length > 0;
    this.lastTextNode = nodeId;
    const text = this.renderCitations(false);
    return text ? [{ kind: "content", text }] : [];
  }

  private parseCompleted(payload: Record<string, unknown>): KagiTurnEvent[] {
    const text = this.renderCitations(true) + this.referenceList();
    const usage = payload.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    const done: KagiTurnEvent = {
      kind: "done",
      usage: usage
        ? {
            prompt_tokens: Number(usage.input_tokens) || 0,
            completion_tokens: Number(usage.output_tokens) || 0,
          }
        : null,
    };
    return text ? [{ kind: "content", text }, done] : [done];
  }
}

/** Yields turn events until the upstream stream ends; always ends on done or error. */
export async function* readKagiTurn(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): AsyncGenerator<KagiTurnEvent> {
  const parser = new KagiTurnParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        for (const event of parser.parseFrame(frame)) {
          yield event;
          if (event.kind === "done" || event.kind === "error") return;
        }
      }
      if (done) break;
    }
    yield { kind: "error", message: "Kagi Assistant stream ended before a final response" };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type ChatUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function withTotal(usage: { prompt_tokens: number; completion_tokens: number } | null) {
  return usage ? { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } : null;
}

function streamAsOpenAi(
  events: AsyncGenerator<KagiTurnEvent>,
  model: string,
  id: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const line = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta: unknown, finishReason: string | null = null, usage?: ChatUsage | null) =>
    line({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
  let sentRole = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      if (!sentRole) {
        sentRole = true;
        controller.enqueue(chunk({ role: "assistant" }));
      }
      if (value.kind === "content") controller.enqueue(chunk({ content: value.text }));
      if (value.kind === "reasoning") controller.enqueue(chunk({ reasoning_content: value.text }));
      if (value.kind === "done") controller.enqueue(chunk({}, "stop", withTotal(value.usage)));
      if (value.kind === "error") {
        controller.enqueue(line({ error: { message: value.message, type: "upstream_error" } }));
      }
      if (value.kind === "done" || value.kind === "error") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
}

export class KagiAssistantExecutor extends BaseExecutor {
  constructor() {
    super("kagi-assistant", { id: "kagi-assistant", baseUrl: KAGI_ASSISTANT_URL });
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;
    const token = normalizeKagiSessionToken(credentials?.apiKey);
    const model = typeof bodyObj.model === "string" ? bodyObj.model : "ki_quick";
    if (!token) {
      return makeErrorResult(401, "Kagi session token required", body, CONVERSATIONS_URL);
    }
    const content = buildKagiPrompt(bodyObj.messages);
    if (!content) {
      return makeErrorResult(400, "Kagi Assistant needs a text message", body, CONVERSATIONS_URL);
    }

    const cookie = `kagi_session=${token}`;
    const transformedBody = { content, model };
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    let turnStream: Response;
    try {
      const started = await fetch(CONVERSATIONS_URL, {
        method: "POST",
        headers: { ...headers, Accept: "application/json" },
        body: JSON.stringify(transformedBody),
        signal,
      });
      if (!started.ok) return kagiHttpError(started.status, body);
      const { assistant_turn_uuid: turnId } = (await started.json()) as {
        assistant_turn_uuid?: unknown;
      };
      if (typeof turnId !== "string" || !/^[\w-]+$/.test(turnId)) {
        return makeErrorResult(502, "Kagi Assistant returned no turn id", body, CONVERSATIONS_URL);
      }
      turnStream = await fetch(`${KAGI_ASSISTANT_URL}/api/v2/turns/${turnId}/stream`, {
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        signal,
      });
      if (!turnStream.ok || !turnStream.body) return kagiHttpError(turnStream.status, body);
    } catch {
      return makeErrorResult(502, "Kagi Assistant request failed", body, CONVERSATIONS_URL);
    }

    const id = `chatcmpl-kagi-${Date.now()}`;
    const events = readKagiTurn(turnStream.body, signal);
    const result = { url: CONVERSATIONS_URL, headers, transformedBody };
    if (wantStream) {
      return {
        ...result,
        response: new Response(streamAsOpenAi(events, model, id), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
      };
    }

    let text = "";
    let reasoning = "";
    let usage: ChatUsage | null = null;
    for await (const event of events) {
      if (event.kind === "content") text += event.text;
      if (event.kind === "reasoning") reasoning += event.text;
      if (event.kind === "done") usage = withTotal(event.usage);
      if (event.kind === "error") {
        return makeErrorResult(502, event.message, body, CONVERSATIONS_URL);
      }
    }
    return {
      ...result,
      response: new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: "stop",
            },
          ],
          ...(usage ? { usage } : {}),
        }),
        { headers: { "Content-Type": "application/json" } }
      ),
    };
  }
}

function kagiHttpError(status: number, body: unknown) {
  const message =
    status === 401 || status === 403
      ? "Invalid or expired Kagi session token"
      : `Kagi Assistant returned HTTP ${status}`;
  return makeErrorResult(status || 502, message, body, CONVERSATIONS_URL);
}
