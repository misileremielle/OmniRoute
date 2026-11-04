/**
 * System One decisions proxy (#13987).
 *
 * POST /v1/systemone forwards one typed-decision request — a `state` plus a
 * map of `questions` (`noul` / `choice` / `score`) — to the backend selected by
 * resolveSystemOneTarget. Every backend (TypeSafe, OpenRouter, operator-added
 * System One-compatible endpoints) shares the same wire shape, so the proxy is a
 * model-rewriting passthrough: every request field the client sent (assets,
 * session ids, provider routing, ...) goes upstream, multipart asset parts are
 * forwarded byte-for-byte, and answers, calibrated probabilities and usage
 * (input/output tokens, cost) flow back untouched — OmniRoute can stand in for
 * api.typesafe.ai behind the TypeSafe SDKs.
 * Decisions models are NOT chat models —
 * decisions-tagged models are excluded from chat pickers by the shared
 * classification (classifyModelSupportedEndpoints).
 *
 * Follows the same credential, rate-limit and call-log contract as
 * handleJinaFoundationProxy (POST /v1/classify).
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog } from "@/lib/usageDb";
import type { SystemOneTarget } from "../config/systemOneRegistry.ts";

/** A multipart file part (an image asset) forwarded with the request. */
export interface SystemOneAssetPart {
  name: string;
  filename: string | null;
  contentType: string;
  data: Uint8Array;
}

const REQUEST_ID_HEADER = "x-typesafe-request-id";

export interface SystemOneCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
}

export interface SystemOneProxyOptions {
  /** Public path the client called ("/v1/systemone"). */
  path: string;
  target: SystemOneTarget;
  body: {
    state?: unknown;
    questions?: unknown;
  } & Record<string, unknown>;
  credentials: SystemOneCredentials | null;
  /** Non-`request` parts of a multipart request (SDK image assets). */
  assetParts?: SystemOneAssetPart[];
  /** Client-requested model id (for logs when upstream reports none). */
  requestedModel?: string | null;
  fetchImpl?: typeof fetch;
}

interface SystemOneUpstreamResponse {
  model?: string;
  answers?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
  error?: { message?: string } | string;
  message?: string;
}

function parseUpstreamBody(text: string): SystemOneUpstreamResponse | null {
  try {
    return text ? (JSON.parse(text) as SystemOneUpstreamResponse) : null;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function upstreamErrorMessage(parsed: SystemOneUpstreamResponse | null): string | undefined {
  const { message, error } = parsed ?? {};
  return message || (typeof error === "string" ? error : error?.message);
}

function buildSuccessResponse(
  parsed: SystemOneUpstreamResponse | null,
  meta: {
    provider: string;
    model: string;
    cost: unknown;
    startTime: number;
    requestId: string | null;
  }
): Response {
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
  if (meta.requestId) headers.set(REQUEST_ID_HEADER, meta.requestId);
  attachOmniRouteMetaHeaders(headers, {
    provider: meta.provider,
    model: meta.model,
    costUsd: typeof meta.cost === "number" ? meta.cost : 0,
    latencyMs: Date.now() - meta.startTime,
    requestId: generateRequestId(),
  });
  return new Response(JSON.stringify(parsed), { status: 200, headers });
}

/**
 * Same layout the TypeSafe SDK sends: a `request` part (application/json, no
 * filename) followed by the asset file parts.
 */
function encodeMultipart(payload: unknown, parts: SystemOneAssetPart[]) {
  const boundary = `omniroute-${crypto.randomUUID().replace(/-/g, "")}`;
  const chunks: Array<string | Uint8Array> = [
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n`,
    `Content-Type: application/json\r\n\r\n`,
    JSON.stringify(payload),
    "\r\n",
  ];
  for (const part of parts) {
    const filename = part.filename ? `; filename="${part.filename.replace(/["\r\n]/g, "_")}"` : "";
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name.replace(/["\r\n]/g, "_")}"${filename}\r\n`,
      `Content-Type: ${part.contentType.replace(/[\r\n]/g, "")}\r\n\r\n`,
      part.data,
      "\r\n"
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    body: new Blob(chunks as BlobPart[]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function postDecision(options: SystemOneProxyOptions, token: string): Promise<Response> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  // Forward the whole request; only the model id is rewritten for the backend.
  const payload = { ...options.body, model: options.target.upstreamModel };
  const assetParts = options.assetParts ?? [];
  const multipart = assetParts.length > 0 ? encodeMultipart(payload, assetParts) : null;
  return fetchImpl(options.target.upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": multipart ? multipart.contentType : "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: multipart ? multipart.body : JSON.stringify(payload),
  });
}

function logDecisionCall(
  options: SystemOneProxyOptions,
  outcome: {
    status: number;
    ok: boolean;
    model: string;
    usage: SystemOneUpstreamResponse["usage"];
    error: string;
    startTime: number;
  }
): void {
  saveCallLog({
    method: "POST",
    path: options.path,
    status: outcome.status,
    model: outcome.model,
    provider: options.target.provider,
    duration: Date.now() - outcome.startTime,
    tokens: {
      prompt_tokens: outcome.usage?.input_tokens ?? 0,
      completion_tokens: outcome.usage?.output_tokens ?? 0,
    },
    connectionId: options.credentials?.connectionId || null,
    ...(outcome.ok ? {} : { error: outcome.error }),
  }).catch(() => {});
}

function resolveAnsweredModel(
  parsed: SystemOneUpstreamResponse | null,
  options: SystemOneProxyOptions
): string {
  const upstreamModel = typeof parsed?.model === "string" ? parsed.model : "";
  return upstreamModel || options.requestedModel || options.target.provider;
}

export async function handleSystemOneProxy(options: SystemOneProxyOptions): Promise<Response> {
  const startTime = Date.now();
  const provider = options.target.provider;
  const token = options.credentials?.apiKey || options.credentials?.accessToken;

  if (!token) {
    return errorResponse(401, `No active credentials for provider: ${provider}`);
  }

  try {
    const res = await postDecision(options, token);
    const text = await res.text();
    const parsed = parseUpstreamBody(text);
    const usage = res.ok ? parsed?.usage : undefined;
    const answeredModel = resolveAnsweredModel(parsed, options);
    const upstreamError = upstreamErrorMessage(parsed);

    logDecisionCall(options, {
      status: res.status,
      ok: res.ok,
      model: answeredModel,
      usage,
      error: upstreamError || text.slice(0, 500),
      startTime,
    });

    if (!res.ok) {
      return errorResponse(res.status, upstreamError || `Provider returned HTTP ${res.status}`);
    }

    return buildSuccessResponse(parsed, {
      provider,
      model: answeredModel,
      cost: usage?.cost,
      startTime,
      requestId: res.headers.get(REQUEST_ID_HEADER),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `System One request failed: ${message}`);
  }
}
