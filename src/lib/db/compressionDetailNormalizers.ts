// Normalizer for the session-dedup DETAIL settings sub-object, which persists to a single
// key_value row (settings.sessionDedup). Extracted out of src/lib/db/compression.ts (frozen
// at cap by file-size-baseline.json — see scripts/check/check-file-size.mjs) rather than
// growing that file inline.
//
// #8388: the session-dedup detail field (minBlockChars) was editable on the
// EngineConfigPage detail form but had no persisted sub-object — mirrors the #8056
// headroom/minRows fix (normalizeHeadroomConfig in compression.ts).
import {
  DEFAULT_SESSION_DEDUP_CONFIG,
  type CompressionConfig,
  type SessionDedupConfig,
} from "@omniroute/open-sse/services/compression/types.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Matches SESSION_DEDUP_SCHEMA bounds (engines/session-dedup/index.ts). */
export function normalizeSessionDedupConfig(value: unknown): SessionDedupConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_SESSION_DEDUP_CONFIG,
    minBlockChars: boundedInt(
      record.minBlockChars,
      DEFAULT_SESSION_DEDUP_CONFIG.minBlockChars,
      1,
      100000
    ),
  };
}

/** Default sub-objects spread into getCompressionSettings' seed config. */
export function buildDetailConfigDefaults(): Pick<CompressionConfig, "sessionDedup"> {
  return {
    sessionDedup: normalizeSessionDedupConfig(undefined),
  };
}

/** Applies a stored sessionDedup row onto config during getCompressionSettings' row scan. */
export function applyDetailConfigUpdate(
  config: CompressionConfig,
  key: "sessionDedup",
  parsed: unknown
): void {
  if (key === "sessionDedup") config.sessionDedup = normalizeSessionDedupConfig(parsed);
}
