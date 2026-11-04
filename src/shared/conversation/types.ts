/**
 * Provider-neutral conversation view model shared by the request-log detail
 * panel and /dashboard/conversations (ChatBubble → MessageContent →
 * ToolCallBlock/ToolResultBlock).
 */

export type NormalizedBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  // A tool identity node whose display content hasn't resolved from its
  // call-log artifact yet (see resolveTurnDisplayContent /
  // /api/conversations/[id]/tree's own doc comment) -- distinct from a real
  // empty text reply. Only ever produced by /dashboard/conversations while
  // the owning request is still in flight; every other NormalizedBlock
  // producer (buildRequestTurns/buildResponseTurns) never emits this.
  | { type: "pending" };

export interface NormalizedTurn {
  role: "system" | "user" | "assistant" | "tool";
  blocks: NormalizedBlock[];
  /** call_logs.id that produced this turn, when a caller has one to attach
   * (e.g. linking a turn back to its source request) — absent for a plain
   * single-request normalization. */
  sourceCallLogId?: string;
  /** ISO timestamp of the call_logs row that produced this turn — same
   * scoping as sourceCallLogId. */
  timestamp?: string;
}

/** The response side of one request, as consumed by `buildResponseTurns`. */
export interface ConversationResponse {
  responseHeaders: Record<string, string>;
  responseBody: string | null;
}
