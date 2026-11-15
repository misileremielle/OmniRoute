/**
 * Dedup marker-protocol note (#8033).
 *
 * session-dedup replaces text already sent earlier in the same session with a
 * `[dedup:ref sha=<8hex>]` marker. This module prepends one idempotent `system`
 * message explaining that marker — the model resolves it by looking back in the
 * conversation, no tool involved — the first time a request carries one.
 */

/** Leading text of the injected note; also the idempotency sentinel. */
export const DEDUP_PROTOCOL_SENTINEL = "[dedup protocol]";

/**
 * Sentinel of the note older releases injected (it also covered the removed CCR
 * engine). A replayed history that still carries it already explains the marker.
 */
const LEGACY_PROTOCOL_SENTINEL = "[CCR protocol]";

/** Prefix of the session-dedup marker (the dedup engine writes the 8-hex sha). */
const DEDUP_MARKER_PREFIX = "[dedup:ref sha=";

const DEDUP_INSTRUCTION =
  `${DEDUP_PROTOCOL_SENTINEL} Some content in this conversation is replaced by markers ` +
  `like \`${DEDUP_MARKER_PREFIX}...]\`, which means that content already appeared earlier — ` +
  `look back in the message history for it.`;

type MessageWithContent = {
  role?: unknown;
  content?: unknown;
};

function messageTextContent(message: MessageWithContent): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>)["text"] === "string"
          ? ((part as Record<string, unknown>)["text"] as string)
          : ""
      )
      .join("\n");
  }
  return "";
}

function hasSentinel(message: MessageWithContent): boolean {
  const text = messageTextContent(message);
  return text.includes(DEDUP_PROTOCOL_SENTINEL) || text.includes(LEGACY_PROTOCOL_SENTINEL);
}

/**
 * Prepend the dedup note when the history carries a dedup marker and no note yet.
 * Returns the same array when nothing is injected.
 */
export function injectDedupProtocolInstruction<T extends MessageWithContent>(messages: T[]): T[] {
  const hasMarker = messages.some((m) => messageTextContent(m).includes(DEDUP_MARKER_PREFIX));
  if (!hasMarker) return messages;
  if (messages.some(hasSentinel)) return messages;
  return [{ role: "system", content: DEDUP_INSTRUCTION } as unknown as T, ...messages];
}

/**
 * Pipeline post-pass: run after every compression engine. Returns the same `body`
 * object when nothing is injected. Malformed bodies fail OPEN — the body passes
 * through untouched.
 */
export function applyDedupProtocolInstruction(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  injected: boolean;
} {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return { body, injected: false };
  try {
    const typed = messages as Array<MessageWithContent>;
    const injected = injectDedupProtocolInstruction(typed);
    if (injected === typed) return { body, injected: false };
    return { body: { ...body, messages: injected }, injected: true };
  } catch (err) {
    console.warn(
      "[compression/session-dedup] applyDedupProtocolInstruction threw; passing the body through unchanged:",
      err instanceof Error ? err.message : err
    );
    return { body, injected: false };
  }
}
