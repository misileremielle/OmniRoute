import { Buffer } from "node:buffer";
/**
 * Speech-to-text handler for POST /v1/audio/transcriptions (OpenAI transcription API).
 *
 * The route parses and validates the multipart form; this module converts the upload when the
 * upstream cannot take its format, calls the upstream named by the transcription registry and
 * maps its answer to OpenAI's `json`, `text`, `verbose_json` or `diarized_json` shape.
 */
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { SafeOutboundFetchError, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { generateRequestId } from "@/shared/utils/requestId";
import {
  resolveAzureSpeechTranscribeUrl,
  type TranscriptionModel,
  type TranscriptionProvider,
} from "../config/transcriptionRegistry.ts";
import {
  AudioTranscodeError,
  sniffAudioContainer,
  transcodeToFlac,
  type AudioBytes,
} from "../utils/audioTranscode.ts";
import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import { buildSanitizedUpstreamErrorResponse } from "../utils/upstreamErrorResponse.ts";

export const TRANSCRIPTION_RESPONSE_FORMATS = [
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
  "diarized_json",
] as const;
export type TranscriptionResponseFormat = (typeof TRANSCRIPTION_RESPONSE_FORMATS)[number];

/** Formats built from timed segments, so the upstream must be asked for timestamps. */
function needsTimestamps(format: TranscriptionResponseFormat): boolean {
  return format !== "json" && format !== "text";
}

export interface TranscriptionRequest {
  file: Blob & { name?: unknown };
  responseFormat: TranscriptionResponseFormat;
  /** ISO-639-1 hint; omitted lets the upstream detect the language. */
  language?: string;
  prompt?: string;
  temperature?: number;
  timestampGranularities: ("word" | "segment")[];
  /** OpenAI `keywords[]`: terms to bias recognition toward. */
  keywords: string[];
}

export interface TranscriptionSuccess {
  provider: string;
  model: string;
  audioSeconds: number | null;
  /** Upstream-reported cost in USD, when the upstream reports one (OpenRouter). */
  reportedCostUsd: number | null;
  requestId: string;
}

type SuccessRecorder = (result: TranscriptionSuccess) => Promise<number | null>;

type Transcode = typeof transcodeToFlac;

export interface HandleTranscriptionOptions {
  request: TranscriptionRequest;
  provider: TranscriptionProvider;
  model: TranscriptionModel;
  credentials: { apiKey?: string; accessToken?: string; baseUrl?: string };
  fetchImpl?: typeof fetch;
  transcodeImpl?: Transcode;
  onSuccess?: SuccessRecorder | null;
  /** The client request's signal; cancels a queued or running conversion and the upstream call. */
  signal?: AbortSignal;
  /**
   * Whether this request may run ffmpeg. Proxy approved conversion for callers with a valid API
   * key; the route passes false for a keyless request (REQUIRE_API_KEY off).
   */
  allowTranscode?: boolean;
}

/** Normalized transcript, built from either upstream before formatting for the client. */
interface Transcript {
  text: string;
  language: string | null;
  durationSeconds: number | null;
  segments: { start: number; end: number; text: string; speaker?: string | number }[];
  words: { word: string; start: number; end: number }[];
  reportedCostUsd: number | null;
}

const TRANSCODE_STATUS: Record<AudioTranscodeError["code"], number> = {
  // The client is gone; the status is only for the log.
  aborted: 408,
  busy: 503,
  ffmpeg_missing: 500,
  decode_failed: 400,
  timeout: 504,
  output_too_large: 413,
};

export async function handleAudioTranscription({
  request,
  provider,
  model,
  credentials,
  fetchImpl = guardedUpstreamFetch,
  transcodeImpl = transcodeToFlac,
  onSuccess = null,
  signal,
  allowTranscode = false,
}: HandleTranscriptionOptions): Promise<Response> {
  const startTime = Date.now();
  const token = credentials.accessToken || credentials.apiKey;
  if (!token)
    return errorResponse(401, `No credentials for transcription provider: ${provider.id}`);

  if (request.responseFormat === "diarized_json" && !model.supportsDiarization) {
    return errorResponse(
      400,
      `Model '${provider.id}/${model.id}' does not support response_format=diarized_json`
    );
  }

  let audio: { bytes: AudioBytes; format: string };
  try {
    audio = await prepareAudio(request.file, provider, transcodeImpl, allowTranscode, signal);
  } catch (error) {
    if (error instanceof AudioTranscodeError) {
      const response = errorResponse(TRANSCODE_STATUS[error.code], error.message);
      if (error.code === "busy") response.headers.set("Retry-After", "5");
      return response;
    }
    if (error instanceof UploadTooLargeError) return errorResponse(413, error.message);
    if (error instanceof UnrecognizedAudioError) return errorResponse(400, error.message);
    if (error instanceof TranscodeNotAllowedError) return errorResponse(401, error.message);
    console.error("[STT] audio preparation failed:", sanitizeErrorMessage(error));
    return errorResponse(500, "Audio preparation failed");
  }

  // One signal covers the upstream request and the body read: the client leaving, or the
  // upstream deadline passing.
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const upstreamSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let result: Transcript | Response;
  try {
    result =
      provider.format === "azure-fast-transcription"
        ? await transcribeWithAzure({
            request,
            model,
            audio,
            token,
            credentials,
            fetchImpl,
            signal: upstreamSignal,
          })
        : await transcribeWithOpenRouter({
            request,
            provider,
            model,
            audio,
            token,
            fetchImpl,
            signal: upstreamSignal,
          });
  } catch (error) {
    return upstreamFailureResponse(error, signal, deadline);
  }
  if (result instanceof Response) return result;

  return buildSuccessResponse(result, request, provider, model, startTime, onSuccess);
}

class UploadTooLargeError extends Error {}

/** Longest an upstream may take to answer and send its body. */
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Upstream fetch through the provider outbound URL policy (the same guard family the
 * connection validator applies), with the resolved address pinned and redirects refused, so
 * the subscription key and the recording only reach the checked host.
 */
export const guardedUpstreamFetch: typeof fetch = (input, init) =>
  safeOutboundFetch(input instanceof Request ? input.url : input, {
    ...init,
    guard: getProviderOutboundGuard(),
    pinDns: true,
    allowRedirect: false,
    retry: false,
    // The shared default (2 min) is too short for a long recording; the caller's signal also
    // carries this deadline over the body read.
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });

function clientClosedResponse(): Response {
  // Nobody reads this; the status keeps the log honest.
  return errorResponse(408, "The client closed the request");
}

function upstreamFailureResponse(
  error: unknown,
  clientSignal: AbortSignal | undefined,
  deadline: AbortSignal
): Response {
  if (clientSignal?.aborted) return clientClosedResponse();
  if (deadline.aborted) return errorResponse(504, "Transcription provider timed out");
  if (error instanceof SafeOutboundFetchError) {
    if (error.code === "URL_GUARD_BLOCKED" || error.code === "INVALID_URL") {
      return errorResponse(400, "Transcription endpoint is blocked by the outbound URL policy");
    }
    if (error.code === "REDIRECT_BLOCKED") {
      return errorResponse(502, "Transcription provider answered with a redirect");
    }
    if (error.code === "TIMEOUT") return errorResponse(504, "Transcription provider timed out");
  }
  console.error("[STT] upstream request failed:", sanitizeErrorMessage(error));
  return errorResponse(502, "Transcription request failed");
}

/**
 * Parse an upstream JSON body. A malformed body yields null (the caller answers 502); an abort
 * while reading is rethrown so it is reported as the client leaving or the deadline passing.
 */
async function readUpstreamJson(res: Response, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

class UnrecognizedAudioError extends Error {}
class TranscodeNotAllowedError extends Error {}

/**
 * The upload as the upstream will receive it: unchanged when the upstream takes its container,
 * else FLAC. The container comes from the bytes (sniffAudioContainer), never the file name or
 * MIME type. That picks the one demuxer ffmpeg may use; it does not prove the media is valid,
 * and ffmpeg still parses whatever passes.
 */
async function prepareAudio(
  file: Blob,
  provider: TranscriptionProvider,
  transcode: Transcode,
  allowTranscode: boolean,
  signal: AbortSignal | undefined
): Promise<{ bytes: AudioBytes; format: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = sniffAudioContainer(bytes);
  if (!container) {
    throw new UnrecognizedAudioError(
      "file is not a recognised audio or video container (flac, mp3, m4a/mp4, mpeg, ogg, wav, webm, aac)"
    );
  }
  if (!provider.acceptedFormats || provider.acceptedFormats.includes(container.format)) {
    if (bytes.byteLength > provider.maxUpstreamBytes) {
      throw new UploadTooLargeError(
        `Audio is ${bytes.byteLength} bytes, above the upstream limit of ${provider.maxUpstreamBytes} bytes`
      );
    }
    return { bytes, format: container.format };
  }
  if (!allowTranscode) {
    throw new TranscodeNotAllowedError(
      `Converting ${container.format} audio for ${provider.id} needs an API key; send wav, mp3 or flac, or authenticate`
    );
  }
  const flac = await transcode(bytes, {
    container,
    maxOutputBytes: provider.maxUpstreamBytes,
    signal,
  });
  return { bytes: flac, format: "flac" };
}

// ── Azure Speech fast transcription ─────────────────────────────────────────

interface AzurePhrase {
  offsetMilliseconds?: number;
  durationMilliseconds?: number;
  text?: string;
  speaker?: number;
  locale?: string;
  words?: { text?: string; offsetMilliseconds?: number; durationMilliseconds?: number }[];
}

interface AzureTranscribeResult {
  durationMilliseconds?: number;
  combinedPhrases?: { text?: string }[];
  phrases?: AzurePhrase[];
}

/** The `definition` part. Shape: learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe */
export function buildAzureDefinition(
  request: TranscriptionRequest,
  model: TranscriptionModel
): Record<string, unknown> {
  const enhancedMode: Record<string, unknown> = {
    enabled: true,
    model: model.wireModel || model.id,
  };
  if (model.supportsModelOptions) {
    // Proxy's decision: readable transcripts. MAI-Transcribe-2 defaults to verbatim.
    const modelOptions: Record<string, unknown> = { transcribeStyle: "clean" };
    // MAI's timestamps default to "none"; segments and words need them requested.
    if (needsTimestamps(request.responseFormat)) {
      modelOptions.timestamps =
        request.responseFormat === "verbose_json" && request.timestampGranularities.includes("word")
          ? "word"
          : "segment";
    }
    enhancedMode.modelOptions = modelOptions;
  }
  const definition: Record<string, unknown> = { enhancedMode };
  if (request.language) definition.locales = [request.language];
  if (request.keywords.length > 0) definition.phraseList = { phrases: request.keywords };
  if (request.responseFormat === "diarized_json") definition.diarization = { enabled: true };
  return definition;
}

async function transcribeWithAzure({
  request,
  model,
  audio,
  token,
  credentials,
  fetchImpl,
  signal,
}: {
  request: TranscriptionRequest;
  model: TranscriptionModel;
  audio: { bytes: AudioBytes; format: string };
  token: string;
  credentials: { baseUrl?: string };
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<Transcript | Response> {
  const url = resolveAzureSpeechTranscribeUrl(credentials.baseUrl);
  if (!url) {
    return errorResponse(
      400,
      "Azure Speech connection needs an https resource endpoint, for example https://eastus.api.cognitive.microsoft.com"
    );
  }
  const form = new FormData();
  // Azure infers the container from the file name; the part type stays neutral.
  form.append(
    "audio",
    new Blob([audio.bytes], { type: "application/octet-stream" }),
    `audio.${audio.format}`
  );
  // The definition part must be application/json; Azure rejects text/plain.
  form.append(
    "definition",
    new Blob([JSON.stringify(buildAzureDefinition(request, model))], { type: "application/json" }),
    "definition.json"
  );
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": token },
    body: form,
    // fetch keeps custom headers across a redirect; never send the key anywhere else.
    redirect: "error",
    signal,
  });
  if (!res.ok) return upstreamError(res, signal);
  const data = (await readUpstreamJson(res, signal)) as AzureTranscribeResult | null;
  if (!isAzureTranscribeResult(data)) {
    return errorResponse(502, "Transcription provider returned an unreadable response");
  }
  return azureToTranscript(data, request.language ?? null);
}

/**
 * A fast-transcription result: at least one of the phrase arrays, each entry an object with
 * string `text`. Silence is empty arrays; anything else is not a transcript and must not be
 * delivered (or billed) as an empty one.
 */
export function isAzureTranscribeResult(data: unknown): data is AzureTranscribeResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const { phrases, combinedPhrases } = data as Record<string, unknown>;
  const entriesHaveText = (list: unknown) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every(
        (entry) =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { text?: unknown }).text === "string"
      ));
  return (
    (Array.isArray(phrases) || Array.isArray(combinedPhrases)) &&
    entriesHaveText(phrases) &&
    entriesHaveText(combinedPhrases)
  );
}

export function azureToTranscript(data: AzureTranscribeResult, requestedLanguage: string | null) {
  const phrases = Array.isArray(data.phrases) ? data.phrases : [];
  const combined = Array.isArray(data.combinedPhrases)
    ? data.combinedPhrases.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean)
    : [];
  const ms = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const segments = phrases.map((phrase) => {
    const start = ms(phrase.offsetMilliseconds) / 1000;
    return {
      start,
      end: start + ms(phrase.durationMilliseconds) / 1000,
      text: typeof phrase.text === "string" ? phrase.text : "",
      ...(typeof phrase.speaker === "number" ? { speaker: phrase.speaker } : {}),
    };
  });
  const words = phrases.flatMap((phrase) =>
    (Array.isArray(phrase.words) ? phrase.words : []).map((word) => {
      const start = ms(word.offsetMilliseconds) / 1000;
      return {
        word: typeof word.text === "string" ? word.text : "",
        start,
        end: start + ms(word.durationMilliseconds) / 1000,
      };
    })
  );
  const transcript: Transcript = {
    text: combined.length > 0 ? combined.join(" ") : segments.map((s) => s.text).join(" "),
    language:
      phrases.find((p) => typeof p.locale === "string" && p.locale)?.locale ?? requestedLanguage,
    durationSeconds:
      typeof data.durationMilliseconds === "number" ? data.durationMilliseconds / 1000 : null,
    segments,
    words,
    reportedCostUsd: null,
  };
  return transcript;
}

// ── OpenRouter STT ──────────────────────────────────────────────────────────

interface OpenRouterSttResult {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start?: number; end?: number; text?: string; speaker?: string | number }[];
  words?: { word?: string; start?: number; end?: number }[];
  usage?: { seconds?: number; cost?: number };
}

/** OpenRouter's JSON STT body. Shape: openrouter.ai/docs/guides/overview/multimodal/stt */
export function buildOpenRouterBody(
  request: TranscriptionRequest,
  model: TranscriptionModel,
  audio: { bytes: AudioBytes; format: string }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.wireModel || model.id,
    input_audio: { data: Buffer.from(audio.bytes).toString("base64"), format: audio.format },
  };
  if (request.language) body.language = request.language;
  if (request.prompt) body.prompt = request.prompt;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.keywords.length > 0) body.keyterms = request.keywords;
  // OpenRouter answers only json or verbose_json (text, srt and vtt are a 400); the other
  // formats are built here from its verbose answer.
  if (needsTimestamps(request.responseFormat) && !model.plainJsonOnly) {
    body.response_format = "verbose_json";
    if (request.responseFormat === "verbose_json" && request.timestampGranularities.length > 0) {
      body.timestamp_granularities = request.timestampGranularities;
    }
  }
  if (request.responseFormat === "diarized_json") {
    if (model.openRouterDiarization === "azure-option") {
      body.provider = { options: { azure: { diarization: { enabled: true } } } };
    } else {
      body.diarize = true;
    }
  }
  return body;
}

async function transcribeWithOpenRouter({
  request,
  provider,
  model,
  audio,
  token,
  fetchImpl,
  signal,
}: {
  request: TranscriptionRequest;
  provider: TranscriptionProvider;
  model: TranscriptionModel;
  audio: { bytes: AudioBytes; format: string };
  token: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<Transcript | Response> {
  const res = await fetchImpl(provider.baseUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildOpenRouterBody(request, model, audio)),
    redirect: "error",
    signal,
  });
  if (!res.ok) return upstreamError(res, signal);
  const data = (await readUpstreamJson(res, signal)) as OpenRouterSttResult | null;
  if (!data || typeof data !== "object" || typeof data.text !== "string") {
    return errorResponse(502, "Transcription provider returned an unreadable response");
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    text: data.text,
    language: typeof data.language === "string" ? data.language : (request.language ?? null),
    durationSeconds:
      typeof data.duration === "number"
        ? data.duration
        : typeof data.usage?.seconds === "number"
          ? data.usage.seconds
          : null,
    segments: (Array.isArray(data.segments) ? data.segments : []).map((segment) => ({
      start: num(segment.start),
      end: num(segment.end),
      text: typeof segment.text === "string" ? segment.text : "",
      ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
    })),
    words: (Array.isArray(data.words) ? data.words : []).map((word) => ({
      word: typeof word.word === "string" ? word.word : "",
      start: num(word.start),
      end: num(word.end),
    })),
    reportedCostUsd:
      typeof data.usage?.cost === "number" && Number.isFinite(data.usage.cost)
        ? data.usage.cost
        : null,
  };
}

// ── Client response ─────────────────────────────────────────────────────────

async function upstreamError(res: Response, signal: AbortSignal | undefined): Promise<Response> {
  return buildSanitizedUpstreamErrorResponse({
    status: res.status,
    rawBody: await res.text().catch((error) => {
      if (signal?.aborted) throw error;
      return "";
    }),
    fallbackMessage: `Transcription provider returned HTTP ${res.status}`,
    headers: CORS_HEADERS,
  });
}

function subtitleTime(seconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(totalMs % 1000, 3)}`;
}

/** SRT or WebVTT cues from the segments; without segments, one cue spans the whole audio. */
export function buildSubtitles(transcript: Transcript, format: "srt" | "vtt"): string {
  const cues = transcript.segments.length
    ? transcript.segments
    : [{ start: 0, end: transcript.durationSeconds ?? 0, text: transcript.text }];
  const separator = format === "srt" ? "," : ".";
  const blocks = cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => {
      const timing = `${subtitleTime(cue.start, separator)} --> ${subtitleTime(cue.end, separator)}`;
      // A blank line ends a cue and `-->` marks a timing line in both formats, so neither may
      // appear in the text.
      const text = cue.text
        .trim()
        .replace(/\n\s*\n/g, "\n")
        .replaceAll("-->", "->");
      return format === "srt" ? `${index + 1}\n${timing}\n${text}` : `${timing}\n${text}`;
    });
  const body = blocks.join("\n\n");
  return format === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}

/** Speaker labels the way OpenAI's diarized_json writes them: A, B, ... by first appearance. */
function speakerLabeler(): (speaker: string | number | undefined) => string {
  const labels = new Map<string, string>();
  return (speaker) => {
    const key = speaker === undefined ? "" : String(speaker);
    let label = labels.get(key);
    if (!label) {
      const index = labels.size;
      label = index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`;
      labels.set(key, label);
    }
    return label;
  };
}

export function formatTranscript(
  transcript: Transcript,
  format: TranscriptionResponseFormat,
  granularities: ("word" | "segment")[]
): { body: string; contentType: string } {
  const usage =
    transcript.durationSeconds !== null
      ? { type: "duration", seconds: transcript.durationSeconds }
      : undefined;
  if (format === "text") {
    return { body: transcript.text, contentType: "text/plain; charset=utf-8" };
  }
  if (format === "srt" || format === "vtt") {
    return { body: buildSubtitles(transcript, format), contentType: "text/plain; charset=utf-8" };
  }
  if (format === "json") {
    return {
      body: JSON.stringify({ text: transcript.text, ...(usage ? { usage } : {}) }),
      contentType: "application/json",
    };
  }
  if (format === "diarized_json") {
    const label = speakerLabeler();
    return {
      body: JSON.stringify({
        task: "transcribe",
        duration: transcript.durationSeconds ?? 0,
        text: transcript.text,
        segments: transcript.segments.map((segment, index) => ({
          type: "transcript.text.segment",
          id: `seg_${String(index + 1).padStart(3, "0")}`,
          start: segment.start,
          end: segment.end,
          text: segment.text,
          speaker: label(segment.speaker),
        })),
        ...(usage ? { usage } : {}),
      }),
      contentType: "application/json",
    };
  }
  const wantSegments = granularities.length === 0 || granularities.includes("segment");
  return {
    body: JSON.stringify({
      task: "transcribe",
      language: transcript.language ?? "",
      duration: transcript.durationSeconds ?? 0,
      text: transcript.text,
      ...(wantSegments
        ? {
            segments: transcript.segments.map((segment, index) => ({
              id: index,
              start: segment.start,
              end: segment.end,
              text: segment.text,
            })),
          }
        : {}),
      ...(granularities.includes("word") ? { words: transcript.words } : {}),
      ...(usage ? { usage } : {}),
    }),
    contentType: "application/json",
  };
}

async function buildSuccessResponse(
  transcript: Transcript,
  request: TranscriptionRequest,
  provider: TranscriptionProvider,
  model: TranscriptionModel,
  startTime: number,
  onSuccess: SuccessRecorder | null
): Promise<Response> {
  const requestId = generateRequestId();
  let costUsd: number | null = transcript.reportedCostUsd;
  if (onSuccess) {
    try {
      costUsd = await onSuccess({
        provider: provider.id,
        model: model.id,
        audioSeconds: transcript.durationSeconds,
        reportedCostUsd: transcript.reportedCostUsd,
        requestId,
      });
    } catch {
      // Accounting is best-effort; a delivered transcript must not turn into an error
      // (a retry would bill the audio twice).
      console.error("[STT accounting] Failed to record completed request");
      costUsd = null;
    }
  }
  const { body, contentType } = formatTranscript(
    transcript,
    request.responseFormat,
    request.timestampGranularities
  );
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": contentType });
  attachOmniRouteMetaHeaders(headers, {
    provider: provider.id,
    model: model.id,
    costUsd,
    latencyMs: Date.now() - startTime,
    requestId,
  });
  if (costUsd === null) headers.delete("X-OmniRoute-Response-Cost");
  return new Response(body, { status: 200, headers });
}
