/**
 * Per-request protocol decisions kept outside the chatCore orchestration god-file: whether a
 * Claude-Code-compatible connection uses the Claude bridge, and whether `store` survives.
 */

import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible.ts";
import { FORMATS } from "../../translator/formats.ts";

export function usesClaudeBridge(
  provider: string,
  _targetFormat: string,
  credentials: unknown
): boolean {
  const configuredTargetFormat = (
    credentials as { providerSpecificData?: { targetFormat?: unknown } | null } | null | undefined
  )?.providerSpecificData?.targetFormat;
  return (
    isClaudeCodeCompatibleProvider(provider) &&
    configuredTargetFormat !== FORMATS.OPENAI &&
    configuredTargetFormat !== FORMATS.OPENAI_RESPONSES
  );
}

export function stripStore(
  body: Record<string, unknown>,
  provider: string,
  targetFormat: string,
  providerSpecificData?: unknown
): void {
  if (provider.startsWith("openai-compatible-") && targetFormat === FORMATS.OPENAI_RESPONSES) {
    const psd =
      providerSpecificData && typeof providerSpecificData === "object"
        ? (providerSpecificData as Record<string, unknown>)
        : undefined;
    if (psd?.openaiStoreEnabled === true) {
      return;
    }
    body.store = false;
    return;
  }

  if (provider !== "openai" && "store" in body) delete body.store;
}
