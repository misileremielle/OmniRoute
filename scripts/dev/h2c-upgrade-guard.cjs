"use strict";

/**
 * Cleartext HTTP/2 (`h2c`) upgrade guard.
 *
 * HTTP/1.1 clients that prefer HTTP/2 — notably the JDK `java.net.http.HttpClient`
 * used by the JetBrains IDEs / Air ("Add an AI provider" connection test) —
 * open a plain-TCP connection with the RFC 9113 §3.2 upgrade handshake:
 *
 *   POST /v1/messages HTTP/1.1
 *   Connection: Upgrade, HTTP2-Settings
 *   Upgrade: h2c
 *   HTTP2-Settings: <base64url>
 *
 * As soon as an `upgrade` listener is registered on a Node `http.Server` (our
 * WebSocket wrappers and Next both register one), Node delivers EVERY request
 * that carries an `Upgrade` header to it instead of `request`. Nothing claims
 * `h2c`, so the socket was closed without a single response byte and the
 * client reported "HTTP/1.1 header parser received no bytes".
 *
 * RFC 9110 §7.8 explicitly allows a server to ignore `Upgrade` and keep
 * answering in HTTP/1.1; the client then simply carries on in HTTP/1.1. This
 * guard does exactly that, for requests whose ONLY offered protocol is `h2c`:
 * it removes the two negotiation headers, pushes the request bytes back into
 * the socket and hands the socket to the server as a fresh connection, so the
 * regular `request` pipeline (peer stamp, method/HEAD guards, Next) serves it.
 *
 * What is deliberately NOT touched:
 *   - Anything that offers another protocol (`websocket`, `h2c, websocket`, …)
 *     keeps flowing to the existing upgrade handlers unchanged.
 *   - TLS connections: RFC 9113 §3.1 forbids the h2c upgrade over https, so we
 *     never rewrite there and the existing behaviour is preserved.
 *
 * Wired into both `standalone-server-ws.mjs` (production: `omniroute serve`,
 * Docker, Electron) and `run-next.mjs` (`npm start` / dev).
 */

// Header names (lowercase) that only exist to negotiate the h2c upgrade.
const NEGOTIATION_HEADERS = new Set(["upgrade", "http2-settings"]);

function offeredUpgradeProtocols(req) {
  const raw = req && req.headers ? req.headers.upgrade : undefined;
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  return String(value || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the request offers `h2c` and nothing else, on a cleartext socket.
 *
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {{ encrypted?: boolean } | undefined} socket
 */
function isCleartextH2cUpgrade(req, socket) {
  if (socket && socket.encrypted) return false;
  const protocols = offeredUpgradeProtocols(req);
  return protocols.length > 0 && protocols.every((protocol) => protocol === "h2c");
}

// `Connection: keep-alive, Upgrade, HTTP2-Settings` -> `keep-alive`; null when empty.
function stripNegotiationTokens(connectionValue) {
  const kept = String(connectionValue)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token && !NEGOTIATION_HEADERS.has(token.toLowerCase()));
  return kept.length > 0 ? kept.join(", ") : null;
}

// Headers that frame the body; replaced when the body is re-sent with a known length.
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding"]);

// Rebuild the request head from `rawHeaders` (preserves case, order and duplicates).
// With `bodyLength`, the original framing is replaced by `Content-Length: bodyLength`.
function serializeRequestHead(req, bodyLength) {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (NEGOTIATION_HEADERS.has(lower)) continue;
    if (bodyLength !== undefined && FRAMING_HEADERS.has(lower)) continue;
    let value = raw[i + 1];
    if (lower === "connection") {
      value = stripNegotiationTokens(value);
      if (value === null) continue;
    }
    head += `${name}: ${value}\r\n`;
  }
  if (bodyLength !== undefined) head += `Content-Length: ${bodyLength}\r\n`;
  return Buffer.from(`${head}\r\n`, "latin1");
}

// Same limit and parsing as src/shared/constants/bodySize.ts (parseRequestBodyLimitBytes),
// which the app's body-size guard applies to MAX_BODY_SIZE_BYTES. Read per request.
const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
function bodyLimitBytes() {
  const value = process.env.MAX_BODY_SIZE_BYTES;
  if (!value) return DEFAULT_BODY_LIMIT_BYTES;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BODY_LIMIT_BYTES;
}

function rejectTooLarge(socket) {
  socket.end("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function reinject(server, socket, bytes) {
  socket.unshift(bytes);
  server.emit("connection", socket);
}

/**
 * Serve an h2c upgrade request as plain HTTP/1.1.
 *
 * @param {import("node:http").Server} server
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:net").Socket} socket
 * @param {Buffer} head bytes Node already read past the request head (start of the body)
 * @returns {boolean} true when the request was re-injected (the caller must stop),
 *   false when it is not an h2c upgrade (the caller continues unchanged).
 */
function handleH2cUpgrade(server, req, socket, head) {
  if (!isCleartextH2cUpgrade(req, socket)) return false;
  const rest = head && head.length > 0 ? head : Buffer.alloc(0);
  // A declared body over the app's limit is refused before anything is read.
  const limit = bodyLimitBytes();
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    rejectTooLarge(socket);
    return true;
  }
  // Node 24 and older leave the body in `head` or on the socket, so the request head
  // goes back in front of it unchanged.
  if (req.complete && !(req.readableLength > 0)) {
    reinject(server, socket, Buffer.concat([serializeRequestHead(req), rest]));
    return true;
  }
  // Node 26 delivers a declared body through `req` instead, already de-chunked: read it
  // there and send it back with a Content-Length that matches what was read. This runs
  // before any auth or size check downstream, so the body is capped at the app's limit.
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on("data", (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > limit) {
      rejected = true;
      chunks.length = 0;
      rejectTooLarge(socket);
      return;
    }
    chunks.push(chunk);
  });
  req.once("end", () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
    reinject(server, socket, Buffer.concat([serializeRequestHead(req, body.length), body, rest]));
  });
  req.once("error", () => socket.destroy());
  return true;
}

module.exports = { isCleartextH2cUpgrade, handleH2cUpgrade };
