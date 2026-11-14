/**
 * chatCore request-translation failure handling (chatCore god-file decomposition, slice 2).
 *
 * Extracted byte-identically from the catch around handleChatCore's request translation: run the
 * plugin onError hook (fail-open, sanitized debug log), derive a 4xx/5xx status, message and error
 * type from the thrown value — defensively, since hostile thrown values may expose Symbols or
 * throwing accessors — build the translation-failure result (translationFailure.ts) and log it.
 * The handler keeps the pending-request finalization and the early return.
 */

import { HTTP_STATUS } from "../../config/constants.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import { createTranslationFailureResult } from "./translationFailure.ts";

type LoggerLike =
  { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null | undefined;

type ThrownLike = {
  statusCode?: unknown;
  message?: unknown;
  errorType?: unknown;
  details?: { error_code?: unknown } | null;
} | null;

export async function buildRequestTranslationErrorResult({
  error,
  log,
}: {
  error: unknown;
  log?: LoggerLike;
}): Promise<ReturnType<typeof createTranslationFailureResult>> {
  const thrown = error as ThrownLike;
  let parsedStatus = Number.NaN;
  try {
    parsedStatus = Number(thrown?.statusCode);
  } catch {
    // Hostile thrown values may expose Symbols or throwing status accessors.
  }
  const statusCode =
    Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus <= 599
      ? parsedStatus
      : HTTP_STATUS.SERVER_ERROR;
  let message = "Invalid request";
  try {
    const candidate = thrown?.message;
    message =
      (typeof candidate === "string" ? candidate : sanitizeErrorMessage(candidate)) || message;
  } catch {
    // Hostile thrown values may expose throwing property accessors.
  }
  let errorType: string | null = null;
  try {
    const candidate = thrown?.errorType;
    errorType = typeof candidate === "string" ? candidate : null;
  } catch {
    // Hostile thrown values may expose throwing classification accessors.
  }
  let detailCode: string | null = null;
  try {
    const candidate = thrown?.details?.error_code;
    detailCode = typeof candidate === "string" ? candidate : null;
  } catch {
    // Hostile thrown values may expose throwing detail accessors.
  }
  const result = createTranslationFailureResult(statusCode, message, errorType, detailCode);
  // Server log only (never the response body): keep the translator's stack so a
  // failure can be traced. Guarded like the reads above — the thrown value may be hostile.
  let stack = "";
  try {
    stack = error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  } catch {
    stack = "";
  }
  log?.warn?.("TRANSLATE", `Request translation failed: ${result.error}${stack}`);
  return result;
}
