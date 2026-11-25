import {
  handleAudioTranscription,
  type TranscriptionRequest,
} from "@omniroute/open-sse/handlers/audioTranscription.ts";
import {
  MAX_TRANSCRIPTION_UPLOAD_BYTES,
  resolveTranscriptionModel,
} from "@omniroute/open-sse/config/transcriptionRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { enforceApiKeyPolicy, validateApiKeyModelPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
  resolveKeyConnectionScope,
} from "@/sse/services/keyConnectionScope";
import {
  MAX_BODY_BYTES_TRANSCRIPTION,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
} from "@/shared/middleware/bodySizeGuard";
import { v1AudioTranscriptionFieldsSchema } from "@/shared/validation/schemas";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { recordTranscriptionRequest } from "@/lib/usage/specialtyRequestAccounting";

/** Form fields OpenAI sends as repeated `name[]` parts. */
const ARRAY_FIELDS = new Set([
  "timestamp_granularities",
  "keywords",
  "known_speaker_names",
  "known_speaker_references",
  "include",
]);

type CollectedForm =
  | { ok: true; file: File; fields: Record<string, string | string[]> }
  | { ok: false; message: string };

/** Split a parsed form into the one `file` part and its text fields. */
export function collectTranscriptionForm(form: FormData): CollectedForm {
  let file: File | null = null;
  const fields: Record<string, string | string[]> = {};
  for (const [rawName, value] of form.entries()) {
    if (rawName === "file") {
      if (typeof value === "string") return { ok: false, message: "file must be an audio upload" };
      if (file) return { ok: false, message: "Send exactly one file" };
      file = value;
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, message: `Field '${rawName}' must be text` };
    }
    const name = rawName.endsWith("[]") ? rawName.slice(0, -2) : rawName;
    if (ARRAY_FIELDS.has(name)) {
      const list = fields[name];
      if (Array.isArray(list)) list.push(value);
      else fields[name] = [value];
      continue;
    }
    if (name in fields) return { ok: false, message: `Field '${name}' was sent more than once` };
    fields[name] = value;
  }
  if (!file) return { ok: false, message: "file is required" };
  return { ok: true, file, fields };
}

/** The connection's resource endpoint lives in providerSpecificData, as for OCR. */
function connectionBaseUrl(credentials: Record<string, unknown>): string | undefined {
  if (typeof credentials.baseUrl === "string" && credentials.baseUrl) return credentials.baseUrl;
  const data = credentials.providerSpecificData as Record<string, unknown> | undefined;
  return typeof data?.baseUrl === "string" && data.baseUrl.trim() ? data.baseUrl : undefined;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/audio/transcriptions — speech to text, OpenAI transcription API compatible.
 * Named combos are not routed here: a combo target would need the multipart upload re-sent.
 */
async function postHandler(request: Request) {
  const startTime = Date.now();
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data/i.test(contentType)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Content-Type must be multipart/form-data");
  }

  // The key's policy runs before any of the upload is read, rate limit included, so a refused
  // key costs no buffering. The model is not known yet: its checks run after parsing and charge
  // nothing more. A request refused there still counts against the rate limit (Proxy's choice).
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;
  const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
  if (scope.rejection) return scope.rejection;

  if (inFlightTranscriptions >= MAX_IN_FLIGHT_TRANSCRIPTIONS) {
    const busy = errorResponse(503, "Too many transcriptions in progress; retry shortly");
    busy.headers.set("Retry-After", "5");
    return busy;
  }
  inFlightTranscriptions++;
  try {
    return await transcribe(request, contentType, startTime, policy, scope.allowedConnections);
  } finally {
    inFlightTranscriptions--;
  }
}

/**
 * Requests between reading the upload and answering. Each holds the upload several times over
 * (request body, parsed file, its bytes, a FLAC or base64 copy), so this bounds memory.
 */
export const MAX_IN_FLIGHT_TRANSCRIPTIONS = 4;
/** A slot is held while the upload arrives, so a stalled or trickling upload must give it up. */
export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
/** 100 MiB at about 1 Mbit/s, a slow phone uplink. */
export const UPLOAD_TOTAL_TIMEOUT_MS = 15 * 60_000;
let uploadTimeouts = {
  idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
  totalTimeoutMs: UPLOAD_TOTAL_TIMEOUT_MS,
};

/** Test hook: shorter upload timeouts; call with no argument to restore the defaults. */
export function __setUploadTimeoutsForTest(timeouts?: {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}): void {
  uploadTimeouts = timeouts ?? {
    idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
    totalTimeoutMs: UPLOAD_TOTAL_TIMEOUT_MS,
  };
}
let inFlightTranscriptions = 0;

async function transcribe(
  request: Request,
  contentType: string,
  startTime: number,
  policy: Awaited<ReturnType<typeof enforceApiKeyPolicy>>,
  allowedConnections: string[] | null
): Promise<Response> {
  let form: FormData;
  try {
    const raw = await readRequestBodyWithLimit(
      request,
      MAX_BODY_BYTES_TRANSCRIPTION,
      uploadTimeouts
    );
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) {
      return errorResponse(408, "Audio upload timed out");
    }
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(
        413,
        `Audio upload is larger than ${MAX_TRANSCRIPTION_UPLOAD_BYTES / (1024 * 1024)} MiB`
      );
    }
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart/form-data body");
  }

  const collected = collectTranscriptionForm(form);
  if (collected.ok === false) return errorResponse(HTTP_STATUS.BAD_REQUEST, collected.message);
  const { file } = collected;
  if (file.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, "file is empty");
  if (file.size > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    return errorResponse(
      413,
      `Audio upload is larger than ${MAX_TRANSCRIPTION_UPLOAD_BYTES / (1024 * 1024)} MiB`
    );
  }

  const validation = validateBody(v1AudioTranscriptionFieldsSchema, collected.fields);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, formatValidationMessage(validation.error));
  }
  const fields = validation.data;

  const resolved = resolveTranscriptionModel(fields.model);
  if (resolved.ok === false) return errorResponse(HTTP_STATUS.BAD_REQUEST, resolved.message);
  const { provider, model } = resolved;
  const fullModel = `${provider.id}/${model.id}`;

  const modelRejection = await validateApiKeyModelPolicy(request, policy, fullModel);
  if (modelRejection) return modelRejection;

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    provider.id,
    null,
    allowedConnections
  );
  if (!credentials) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider.id}`);
  }
  if (isKeyScopeBlockedCredentials(credentials)) {
    return keyScopeBlockedResponse(provider.id, credentials);
  }
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse(provider.id, credentials);
  }

  const record = credentials as Record<string, unknown>;
  const transcriptionRequest: TranscriptionRequest = {
    file,
    responseFormat: fields.response_format,
    language: fields.language,
    prompt: fields.prompt,
    temperature: fields.temperature,
    timestampGranularities: fields.timestamp_granularities,
    keywords: fields.keywords,
  };
  const response = await handleAudioTranscription({
    request: transcriptionRequest,
    provider,
    model,
    credentials: {
      apiKey: typeof record.apiKey === "string" ? record.apiKey : undefined,
      accessToken: typeof record.accessToken === "string" ? record.accessToken : undefined,
      baseUrl: connectionBaseUrl(record),
    },
    signal: request.signal,
    // Proxy approved ffmpeg for callers with a valid API key; a keyless request
    // (REQUIRE_API_KEY off) may still send formats that need no conversion.
    allowTranscode: Boolean(policy.apiKeyInfo),
    onSuccess: (result) =>
      recordTranscriptionRequest({
        ...result,
        apiKeyId: policy.apiKeyInfo?.id,
        apiKeyName: policy.apiKeyInfo?.name,
        connectionId: typeof record.connectionId === "string" ? record.connectionId : null,
        startTime,
      }),
  });
  if (response.ok) await clearRecoveredProviderState(credentials);
  return response;
}

export const POST = postHandler;
