type Message = { role: string; content: unknown; [key: string]: unknown };

function toTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: unknown } => {
        return (
          Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
        );
      })
      .map((part) => String(part.text ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * Providers that accept a system-role message ONLY at index 0 (a `system`
 * message at any later position is rejected with HTTP 400). See #6135.
 *
 * Populated with the Xiaomi MiMo endpoint (provider id `xiaomi-mimo`, registry
 * alias `mimo`, serving mimo-v2.5) confirmed live to 400 on a non-first system
 * message, and the TokenRouter gateway (provider id `tokenrouter`), confirmed
 * live on 2026-08-22 to reject mid-array system messages — including the
 * compression notice spliced by purifyHistory() before that splice was fixed to
 * merge into the leading system message. Add other providers here only when
 * they are documented as strict.
 *
 * Self-hosted deployments can extend this list without a source change via
 * OMNIROUTE_STRICT_SYSTEM_PROVIDERS (comma-separated provider ids,
 * case-insensitive) — e.g. a custom OpenAI-compatible connection in front of a
 * self-hosted Qwen3.5+/3.6 model, whose chat template enforces the same
 * single-leading-system-message constraint as xiaomi-mimo.
 */
const BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST = new Set(["xiaomi-mimo", "mimo", "tokenrouter"]);

/**
 * Parses OMNIROUTE_STRICT_SYSTEM_PROVIDERS into a normalized id list.
 * Exported for tests; not expected to be called directly by other modules.
 */
export function parseStrictSystemProvidersEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OMNIROUTE_STRICT_SYSTEM_PROVIDERS ?? "";
  return raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

function resolveProvidersSystemMustBeFirst(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = parseStrictSystemProvidersEnv(env);
  if (extra.length === 0) return BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST;
  return new Set([...BUILTIN_PROVIDERS_SYSTEM_MUST_BE_FIRST, ...extra]);
}

/**
 * Returns true when the given provider requires the system message to be first.
 * Falls back to false for unknown/null providers (preserves current behavior).
 * Honors OMNIROUTE_STRICT_SYSTEM_PROVIDERS for self-hosted additions (see above).
 */
export function systemMessageMustBeFirst(
  provider: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!provider) return false;
  const normalized = provider.toLowerCase().trim();
  return resolveProvidersSystemMustBeFirst(env).has(normalized);
}

/**
 * #7293: hoist every `system`-role message onto index 0 for providers that reject a
 * non-first system message (`systemMessageMustBeFirst()` — the single source of truth
 * already used by `src/lib/memory/injection.ts`'s memory-injection half, #6135/PR#6225).
 *
 * `translateRequest()` is the single outbound choke point every request passes through,
 * including same-format (OpenAI→OpenAI) passthrough where none of the format-specific
 * translators run — so a client-injected `system` message landing mid-array (OpenCode /
 * Kilo Code style clients, Discussion #6129) previously reached the upstream untouched.
 *
 * Merge, never drop: multiple offending system messages are folded (in original order)
 * into the single leading system message, mirroring `injectSystemFirst()`'s
 * `${memoryText}\n${first.content}` pattern and `openai-to-claude.ts`'s system-array-merge
 * pattern.
 *
 * No-op (same array reference) whenever the provider is not strict, or the request is
 * already compliant — required for prompt-cache prefix stability (#3890 class).
 *
 * #13948: callers must NOT invoke this for sourceFormat===CLAUDE&&targetFormat===OPENAI —
 * claude-to-openai.ts's demoteMidSystem already enforces the restriction in position for
 * that path, and hoisting first (on the pre-translation Claude array) makes the later
 * demote-in-place inherit the hoisted index instead of the original chronological one.
 * See open-sse/translator/index.ts's call sites for the guard.
 */
export function hoistLeadingSystemMessage(
  messages: Message[],
  provider: string | null | undefined
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!systemMessageMustBeFirst(provider)) return messages;

  const offendingIndices: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "system") offendingIndices.push(i);
  }
  if (offendingIndices.length === 0) return messages;

  const offending = offendingIndices.map((i) => messages[i]);
  const rest = messages.filter((_, i) => !offendingIndices.includes(i));

  const mergedText = [
    rest[0]?.role === "system" ? toTextContent(rest[0].content) : null,
    ...offending.map((m) => toTextContent(m.content)),
  ]
    .filter((text): text is string => Boolean(text))
    .join("\n");

  if (rest[0]?.role === "system") {
    const mergedFirst: Message = { ...rest[0], content: mergedText };
    return [mergedFirst, ...rest.slice(1)];
  }

  const leadingSystem: Message = { role: "system", content: mergedText };
  return [leadingSystem, ...rest];
}
