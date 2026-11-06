/**
 * WebSocket Live Dashboard — Protocol Types
 *
 * Wire format for the real-time dashboard WebSocket.
 */

// The channel list comes from the event catalog so the wire types cannot drift from the
// channels the server actually emits (they had kept a removed "agents" and lacked "proxy").
import type { DashboardChannel } from "@/lib/events/types";

// ── Client → Server ───────────────────────────────────────────────────────

export interface WsSubscribeMessage {
  type: "subscribe";
  channels: DashboardChannel[];
}

export interface WsPingMessage {
  type: "ping";
}

export type WsClientMessage = WsSubscribeMessage | WsPingMessage;

// ── Server → Client ───────────────────────────────────────────────────────

export interface WsEventMessage {
  type: "event";
  channel: DashboardChannel;
  event: string;
  data: unknown;
}

export interface WsPongMessage {
  type: "pong";
}

export interface WsWelcomeMessage {
  type: "welcome";
  version: string;
  sessionId: string;
  serverTime: number;
  channels: DashboardChannel[];
  /** Number of buffered events since last reconnect */
  backlog: number;
}

export interface WsErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type WsServerMessage = WsEventMessage | WsPongMessage | WsWelcomeMessage | WsErrorMessage;

// ── Auth ─────────────────────────────────────────────────────────────────

export interface WsAuthResult {
  authorized: boolean;
  sessionId: string;
  error?: string;
}
