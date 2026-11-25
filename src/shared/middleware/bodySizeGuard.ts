/**
 * Body Size Guard — E-1 Critical Fix
 *
 * Middleware helper that rejects oversized request bodies
 * before they are parsed, preventing OOM from malicious payloads.
 *
 * Usage:
 *   import { checkBodySize, MAX_BODY_BYTES } from "@/shared/middleware/bodySizeGuard";
 *
 *   const rejection = checkBodySize(request);
 *   if (rejection) return rejection;
 *
 * @module shared/middleware/bodySizeGuard
 */

import {
  normalizeRequestBodyLimitMb,
  parseRequestBodyLimitBytes,
  requestBodyLimitMbToBytes,
} from "../constants/bodySize";
import { MAX_TRANSCRIPTION_UPLOAD_BYTES } from "@omniroute/open-sse/config/transcriptionRegistry.ts";

/** Larger limit for backup/import routes: 100 MB */
export const MAX_BODY_BYTES_IMPORT = 100 * 1024 * 1024;

/**
 * Default limit for LLM request payloads: 50 MB. A saved `maxBodySizeMb` replaces it, up or down;
 * without one, this stays the floor so long-context agent payloads keep working.
 */
export const MAX_BODY_BYTES_LLM_API = 50 * 1024 * 1024;

/** Audio uploads: the largest accepted recording plus room for the multipart framing and fields. */
export const MAX_BODY_BYTES_TRANSCRIPTION = MAX_TRANSCRIPTION_UPLOAD_BYTES + 1024 * 1024;

/** Configured limit — reads from env or falls back to 10 MB */
export const MAX_BODY_BYTES = parseRequestBodyLimitBytes(process.env.MAX_BODY_SIZE_BYTES);

type BodySizeRule = {
  prefix: string;
  limit: number;
  exactPath?: boolean;
  fixedLimit?: boolean;
  /** A saved `maxBodySizeMb` replaces this limit instead of only raising it. */
  savedLimitWins?: boolean;
};

const ROUTE_LIMITS: BodySizeRule[] = [
  { prefix: "/api/db-backups/import", limit: MAX_BODY_BYTES_IMPORT },
  // The route reads at most this much itself, so a larger saved limit would not help.
  {
    prefix: "/api/v1/audio/transcriptions",
    limit: MAX_BODY_BYTES_TRANSCRIPTION,
    exactPath: true,
    fixedLimit: true,
  },
  { prefix: "/api/v1/chat/completions", limit: MAX_BODY_BYTES_LLM_API, savedLimitWins: true },
  { prefix: "/api/v1/responses", limit: MAX_BODY_BYTES_LLM_API, savedLimitWins: true },
  { prefix: "/api/v1/messages", limit: MAX_BODY_BYTES_LLM_API, savedLimitWins: true },
];

export function getConfiguredBodySizeLimitBytes(settings?: Record<string, unknown>): number {
  const configuredMb = normalizeRequestBodyLimitMb(settings?.maxBodySizeMb);
  return configuredMb === null ? MAX_BODY_BYTES : requestBodyLimitMbToBytes(configuredMb);
}

/**
 * The limit an operator actually saved, in bytes, or null. `settings.maxBodySizeMb` cannot answer
 * this: getSettings() fills it with the default when nothing was saved. See
 * getCachedBodySizeSettings(), which adds `savedMaxBodySizeMb`.
 */
export function getSavedBodySizeLimitBytes(settings?: Record<string, unknown>): number | null {
  const savedMb = normalizeRequestBodyLimitMb(settings?.savedMaxBodySizeMb);
  return savedMb === null ? null : requestBodyLimitMbToBytes(savedMb);
}

/**
 * Resolve the body size limit for a request path.
 */
export function getBodySizeLimit(pathname: string, settings?: Record<string, unknown>): number {
  const configuredLimit = getConfiguredBodySizeLimitBytes(settings);
  const customRule = ROUTE_LIMITS.find((rule) =>
    rule.exactPath ? pathname === rule.prefix : pathname.startsWith(rule.prefix)
  );
  if (!customRule) return configuredLimit;
  const savedLimit = customRule.savedLimitWins ? getSavedBodySizeLimitBytes(settings) : null;
  if (savedLimit !== null) return savedLimit;
  return customRule.fixedLimit ? customRule.limit : Math.max(customRule.limit, configuredLimit);
}

/**
 * Check Content-Length header against the configured limit.
 * Returns a 413 Response if the body is too large, or null if OK.
 */
export function checkBodySize(request: Request, limit: number = MAX_BODY_BYTES): Response | null {
  const contentLength = request.headers.get("content-length");

  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(bytes) && bytes > limit) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Request body too large. Maximum allowed: ${formatBytes(limit)}`,
            type: "payload_too_large",
            code: "PAYLOAD_TOO_LARGE",
          },
        }),
        {
          status: 413,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
  }

  return null;
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${formatBytes(limit)}`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  constructor(readonly reason: "idle" | "total") {
    super(reason === "idle" ? "Request body stalled" : "Request body took too long to arrive");
    this.name = "RequestBodyTimeoutError";
  }
}

export interface ReadRequestBodyTimeouts {
  /** Longest wait for the next chunk. */
  idleTimeoutMs?: number;
  /** Longest the whole body may take. */
  totalTimeoutMs?: number;
}

/** One chunk, or a RequestBodyTimeoutError when the chunk or the whole body is late. */
function readChunkWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeouts: ReadRequestBodyTimeouts,
  deadline: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const { idleTimeoutMs } = timeouts;
  const totalLeft = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
  // Checked before reading: a chunk or EOF already queued would otherwise win the race against
  // a zero-delay timer and let the body finish after its deadline.
  if (totalLeft <= 0) return Promise.reject(new RequestBodyTimeoutError("total"));
  if (idleTimeoutMs === undefined && totalLeft === Infinity) return reader.read();
  const idleFirst = idleTimeoutMs !== undefined && idleTimeoutMs <= totalLeft;
  const waitMs = Math.max(0, idleFirst ? idleTimeoutMs : totalLeft);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RequestBodyTimeoutError(idleFirst ? "idle" : "total")),
      waitMs
    );
  });
  return Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
}

/**
 * Read a request body while enforcing the actual streamed byte count. This closes the gap left by
 * Content-Length-only admission for chunked or deliberately mislabelled requests. The optional
 * timeouts also bound a body that trickles in: a byte limit alone lets a stalled client hold the
 * reader open indefinitely.
 */
export async function readRequestBodyWithLimit(
  request: Request,
  limit: number,
  timeouts: ReadRequestBodyTimeouts = {}
): Promise<Uint8Array<ArrayBuffer>> {
  const deadline =
    timeouts.totalTimeoutMs === undefined ? Infinity : Date.now() + timeouts.totalTimeoutMs;
  const declaredLength = Number.parseInt(request.headers.get("content-length") || "", 10);
  if (!Number.isNaN(declaredLength) && declaredLength > limit) {
    throw new RequestBodyTooLargeError(limit);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readChunkWithin(reader, timeouts, deadline);
      } catch (error) {
        if (error instanceof RequestBodyTimeoutError) {
          // Not awaited: a cancel that never settles must not keep the caller (and the upload
          // slot it holds) waiting.
          void reader.cancel("request body timed out").catch(() => {});
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Not awaited, as for a timeout: the 413 must not wait on a cancel that never settles.
        void reader.cancel("request body too large").catch(() => {});
        throw new RequestBodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A read the timeout abandoned can still be pending; the lock goes with the stream.
    }
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Format bytes as human-readable string */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}
