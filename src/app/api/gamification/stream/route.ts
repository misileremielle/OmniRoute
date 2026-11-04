/**
 * SSE Leaderboard Stream — /api/gamification/stream
 *
 * Pushes live leaderboard updates to connected clients via Server-Sent Events.
 * Supports all leaderboard scopes (global, weekly, monthly, tokens_shared, contributions).
 */

import { NextRequest } from "next/server";
import { type LeaderboardScope, getTopN } from "@/lib/gamification/leaderboard";
import { CORS_HEADERS } from "@/shared/utils/cors";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const VALID_SCOPES: ReadonlySet<string> = new Set([
  "global",
  "weekly",
  "monthly",
  "tokens_shared",
  "contributions",
]);

/**
 * GET /api/gamification/stream — SSE leaderboard updates
 *
 * Query params:
 *   scope — one of: global, weekly, monthly, tokens_shared, contributions (default: global)
 */
export async function GET(request: NextRequest) {
  const authErr = await requireManagementAuth(request);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const rawScope = url.searchParams.get("scope") || "global";
  const scope: LeaderboardScope = VALID_SCOPES.has(rawScope)
    ? (rawScope as LeaderboardScope)
    : "global";

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let updater: ReturnType<typeof setInterval> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  // Idempotent teardown shared by client abort and stream cancel(). Without it a
  // client that disconnected while auth was still pending (signal already aborted,
  // "abort" never fires again) kept a 5s leaderboard query + 15s heartbeat running
  // for the life of the process, and a late enqueue on the closed controller threw.
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (updater) clearInterval(updater);
    heartbeat = null;
    updater = null;
    request.signal.removeEventListener("abort", cleanup);
    try {
      streamController?.close();
    } catch {
      /* already closed */
    }
  };

  const safeEnqueue = (chunk: string) => {
    if (closed || !streamController) return;
    try {
      streamController.enqueue(encoder.encode(chunk));
    } catch {
      cleanup();
    }
  };

  const sendUpdate = async () => {
    if (closed) return;
    try {
      const entries = await getTopN(scope, 50);
      safeEnqueue(`data: ${JSON.stringify({ type: "leaderboard", scope, entries })}\n\n`);
    } catch (err) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      // Send initial state
      void sendUpdate();

      // Heartbeat every 15s
      heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);

      // Update every 5s
      updater = setInterval(() => void sendUpdate(), 5_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
