/**
 * POST/GET handler for /v1/systemone (#13987). Credential selection, rate-limit
 * handling and usage logging mirror /v1/classify (Jina passthrough).
 */

import {
  handleSystemOneProxy,
  type SystemOneCredentials,
} from "@omniroute/open-sse/handlers/systemOne.ts";
import { resolveSystemOneTarget } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { createInjectionGuard, withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { getCachedProviderNodes } from "@/lib/db/readCache";
import { CORS_HEADERS } from "@omniroute/open-sse/utils/cors.ts";
import { decodeSystemOneRequest, isSystemOneDecodeFailure } from "./systemOneRequest";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
  resolveKeyConnectionScope,
} from "@/sse/services/keyConnectionScope";
import { v1SystemOneSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";

function optionsResponse() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** Decisions models advertised by the unified catalog (type "decisions"). */
export function systemOneModelsGet(pathname: string) {
  return (request?: Request) =>
    getSpecialtyModelsResponse(request, pathname, (model) => {
      if (model.type === "decisions") return true;
      const endpoints = model.supported_endpoints;
      return Array.isArray(endpoints) && endpoints.includes("decisions");
    });
}

const injectionGuard = createInjectionGuard();

/** Operator-added System One-compatible endpoints (custom `<prefix>/<model>` routing). */
async function loadSystemOneCompatibleNodes() {
  try {
    const nodes = await getCachedProviderNodes();
    return (Array.isArray(nodes) ? nodes : []).filter(
      (node) => (node as { type?: unknown })?.type === "systemone-compatible"
    ) as Array<{ id: string; prefix?: string | null; baseUrl?: string | null; type?: string }>;
  } catch {
    return [];
  }
}

/** Requests from the official TypeSafe SDKs carry `X-TypeSafe-SDK: typesafe-sdk/<version>`. */
export function isTypeSafeSdkRequest(request: Request): boolean {
  return request.headers.has("x-typesafe-sdk");
}

/**
 * `client.models.list()` in the TypeSafe SDK reads GET {baseURL}/v1/models and
 * requires `{ models: [{ name, description, release_date }] }`. Answer that shape
 * (decisions models only) when the SDK asks, so OmniRoute works as its baseURL.
 */
export async function typeSafeSdkModelsResponse(request: Request): Promise<Response> {
  const listed = await systemOneModelsGet("/v1/models")(request);
  if (!listed.ok) return listed;
  const payload = (await listed.json()) as { data?: Array<Record<string, unknown>> };
  const models = (Array.isArray(payload.data) ? payload.data : []).map((entry) => {
    const created = typeof entry.created === "number" ? entry.created : null;
    return {
      name: String(entry.id ?? ""),
      description:
        typeof entry.description === "string"
          ? entry.description
          : typeof entry.name === "string"
            ? entry.name
            : "",
      release_date: created ? new Date(created * 1000).toISOString().slice(0, 10) : "",
    };
  });
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function postHandler(
  request: Request,
  _context?: unknown,
  preParsedBody?: unknown
): Promise<Response> {
  // TypeSafe SDK bodies may be zstd-compressed and/or multipart (image assets).
  const decoded = await decodeSystemOneRequest(request);
  if (isSystemOneDecodeFailure(decoded)) return errorResponse(decoded.status, decoded.message);
  const rawBody = decoded.payload;

  // withInjectionGuard only scans bodies it can read as plain JSON; run the same
  // guard on the decoded payload when it could not (compressed / multipart).
  if (preParsedBody == null && rawBody && typeof rawBody === "object") {
    const { blocked, result }: { blocked: boolean; result: { detections: unknown[] } } =
      injectionGuard(rawBody as Record<string, unknown>);
    if (blocked) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Request blocked: potential prompt injection detected",
            type: "injection_detected",
            code: "SECURITY_001",
            detections: result.detections.length,
          },
        }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
  }

  const validation = validateBody(v1SystemOneSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;
  const model = typeof body.model === "string" ? body.model.trim() : undefined;

  const target = resolveSystemOneTarget(model, await loadSystemOneCompatibleNodes());
  if (!target) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown decisions model: ${model ?? "(missing)"}. Use "typesafe/<model>", ` +
        `a bare jev-* alias, "openrouter/<vendor>/<model>" for OpenRouter-hosted decisions ` +
        `models, or "<prefix>/<model>" for a System One-compatible endpoint you added.`
    );
  }

  const policy = await enforceApiKeyPolicy(request, model ?? target.upstreamModel);
  if (policy.rejection) return policy.rejection;

  // GHSA-3w2r: credential selection stays inside the key's connection scope,
  // the same scope /v1/classify and chat apply.
  const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
  if (scope.rejection) return scope.rejection;

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    target.provider,
    null,
    scope.allowedConnections
  );
  if (!credentials) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No active credentials for provider: ${target.provider}`
    );
  }
  if (isKeyScopeBlockedCredentials(credentials)) {
    return keyScopeBlockedResponse(target.provider, credentials);
  }
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse(target.provider, credentials);
  }

  const response = await handleSystemOneProxy({
    path: new URL(request.url).pathname,
    target,
    // Forward what the client sent, not the schema's normalized copy (the
    // schema trims strings; a drop-in System One proxy must not alter `state`).
    body: rawBody as typeof body,
    // The key-scope-blocked and all-rate-limited sentinels were refused above;
    // what is left is a real credential record.
    credentials: credentials as SystemOneCredentials,
    assetParts: decoded.assetParts,
    requestedModel: model ?? null,
  });
  if (response.ok) {
    await clearRecoveredProviderState(credentials);
  }
  return response;
}

export function createSystemOneRouteHandlers(pathname: string) {
  return {
    OPTIONS: optionsResponse,
    GET: systemOneModelsGet(pathname),
    POST: withInjectionGuard(postHandler),
  };
}
