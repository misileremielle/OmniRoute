import { hasUnsafeModelIdSyntax } from "../utils/modelIdSafety.ts";

/**
 * Speech-to-text provider registry for POST /v1/audio/transcriptions.
 *
 * The request and response follow OpenAI's transcription API. Each provider names the wire
 * format its upstream speaks:
 *
 * - `azure-fast-transcription`: Azure Speech fast transcription
 *   (`{endpoint}/speechtotext/transcriptions:transcribe`, multipart `audio` + JSON
 *   `definition`) with MAI-Transcribe selected through `enhancedMode`.
 *   https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
 * - `openrouter-stt`: OpenRouter's JSON STT endpoint (`input_audio` { data, format }).
 *   https://openrouter.ai/docs/guides/overview/multimodal/stt
 *
 * API keys come from the normal provider connections, keyed by provider id.
 */

export type TranscriptionWireFormat = "azure-fast-transcription" | "openrouter-stt";

export interface TranscriptionModel {
  /** Id clients send after the provider prefix, matched case-insensitively. */
  id: string;
  name: string;
  /** Model string the upstream expects, when it differs from `id`. */
  wireModel?: string;
  /** Speaker labels (`response_format=diarized_json`) are available. */
  supportsDiarization?: boolean;
  /** Azure `enhancedMode.modelOptions` (transcribeStyle, timestamps) are accepted. */
  supportsModelOptions?: boolean;
  /**
   * OpenRouter rejects `response_format: "verbose_json"` for this model with a 400. It is then
   * asked for plain `json` and the verbose shape is built from the text alone.
   */
  plainJsonOnly?: boolean;
  /**
   * How OpenRouter turns on speaker labels: the top-level `diarize` flag, or the Azure endpoint's
   * own `provider.options.azure.diarization` (OpenRouter's documented way for MAI-Transcribe).
   */
  openRouterDiarization?: "flag" | "azure-option";
}

export interface TranscriptionProvider {
  id: string;
  /** Default upstream URL; empty when the connection must supply its own endpoint. */
  baseUrl: string;
  format: TranscriptionWireFormat;
  /**
   * Container formats the upstream accepts, by file extension. Anything else is converted to
   * FLAC first. `null` means the upstream takes any format the OpenAI API lists.
   */
  acceptedFormats: readonly string[] | null;
  /** Largest upload the upstream accepts, in bytes, after any conversion. */
  maxUpstreamBytes: number;
  models: readonly TranscriptionModel[];
}

const MIB = 1024 * 1024;

/** Largest upload /v1/audio/transcriptions reads into memory, before any conversion. */
export const MAX_TRANSCRIPTION_UPLOAD_BYTES = 100 * MIB;

/** Azure fast transcription API version; MAI-Transcribe needs 2025-10-15 or later. */
export const AZURE_SPEECH_API_VERSION = "2025-10-15";

export const TRANSCRIPTION_PROVIDERS: Record<string, TranscriptionProvider> = {
  "azure-speech": {
    id: "azure-speech",
    baseUrl: "",
    format: "azure-fast-transcription",
    // MAI-Transcribe documents WAV, MP3 and FLAC only.
    acceptedFormats: ["wav", "mp3", "flac"],
    // Transcriptions - Transcribe: "smaller than 250 MB", "shorter than 2 hours".
    maxUpstreamBytes: 250 * 1000 * 1000,
    models: [
      {
        id: "mai-transcribe-2",
        name: "Microsoft MAI-Transcribe 2",
        wireModel: "MAI-Transcribe-2",
        supportsDiarization: true,
        supportsModelOptions: true,
      },
      {
        id: "mai-transcribe-1.5",
        name: "Microsoft MAI-Transcribe 1.5",
        wireModel: "MAI-Transcribe-1.5",
      },
    ],
  },

  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1/audio/transcriptions",
    format: "openrouter-stt",
    acceptedFormats: ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"],
    maxUpstreamBytes: 100 * MIB,
    // Mirrors upstream OmniRoute's OpenRouter STT list (v3.8.55 audioRegistry), plus
    // MAI-Transcribe 2 (https://openrouter.ai/microsoft/mai-transcribe-2).
    models: [
      {
        id: "microsoft/mai-transcribe-2",
        name: "Microsoft MAI-Transcribe 2",
        supportsDiarization: true,
        openRouterDiarization: "azure-option",
      },
      {
        id: "microsoft/mai-transcribe-1.5",
        name: "Microsoft MAI-Transcribe 1.5",
        plainJsonOnly: true,
      },
      {
        id: "deepgram/nova-3",
        name: "Deepgram Nova-3",
        supportsDiarization: true,
        openRouterDiarization: "flag",
      },
      { id: "nvidia/parakeet-tdt-0.6b-v3", name: "NVIDIA Parakeet TDT 0.6B v3" },
      { id: "mistralai/voxtral-mini-transcribe", name: "Mistral Voxtral Mini Transcribe" },
      { id: "qwen/qwen3-asr-flash-2026-02-10", name: "Qwen3 ASR Flash 2026-02-10" },
      { id: "google/chirp-3", name: "Google Chirp 3" },
      // OpenAI documents json as the only format of both gpt-4o transcribe models.
      {
        id: "openai/gpt-4o-mini-transcribe",
        name: "OpenAI GPT-4o Mini Transcribe",
        plainJsonOnly: true,
      },
      { id: "openai/gpt-4o-transcribe", name: "OpenAI GPT-4o Transcribe", plainJsonOnly: true },
      { id: "openai/whisper-large-v3", name: "OpenAI Whisper Large v3" },
      { id: "openai/whisper-large-v3-turbo", name: "OpenAI Whisper Large v3 Turbo" },
      { id: "openai/whisper-1", name: "OpenAI Whisper 1" },
    ],
  },
};

export function getTranscriptionProvider(providerId: string): TranscriptionProvider | null {
  return Object.prototype.hasOwnProperty.call(TRANSCRIPTION_PROVIDERS, providerId)
    ? TRANSCRIPTION_PROVIDERS[providerId]
    : null;
}

function findModel(provider: TranscriptionProvider, modelId: string): TranscriptionModel | null {
  const wanted = modelId.toLowerCase();
  return provider.models.find((model) => model.id.toLowerCase() === wanted) ?? null;
}

export type TranscriptionModelResolution =
  | { ok: true; provider: TranscriptionProvider; model: TranscriptionModel }
  | { ok: false; status: 400; message: string };

/**
 * Resolve a client model string the way chat resolves models (src/sse/handlers/chatHelpers.ts):
 * an explicit `provider/model` wins; an unprefixed id is accepted when exactly one provider
 * serves it; otherwise the request fails with 400 and names the ids that would work.
 */
export function resolveTranscriptionModel(rawModel: unknown): TranscriptionModelResolution {
  const modelStr = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!modelStr) return { ok: false, status: 400, message: "model is required" };
  if (hasUnsafeModelIdSyntax(modelStr)) {
    return { ok: false, status: 400, message: "Invalid model format" };
  }

  const slash = modelStr.indexOf("/");
  if (slash > 0) {
    const provider = getTranscriptionProvider(modelStr.slice(0, slash));
    if (provider) {
      const model = findModel(provider, modelStr.slice(slash + 1));
      if (model) return { ok: true, provider, model };
      return {
        ok: false,
        status: 400,
        message: `Model '${modelStr}' is not a transcription model of provider '${provider.id}'. Available: ${listModelIds(provider).join(", ")}.`,
      };
    }
  }

  const candidates: { provider: TranscriptionProvider; model: TranscriptionModel }[] = [];
  for (const provider of Object.values(TRANSCRIPTION_PROVIDERS)) {
    const model = findModel(provider, modelStr);
    if (model) candidates.push({ provider, model });
  }
  if (candidates.length === 1) return { ok: true, ...candidates[0] };
  if (candidates.length > 1) {
    return {
      ok: false,
      status: 400,
      message: `Ambiguous model '${modelStr}'. Use provider/model prefix (ex: ${candidates
        .map(({ provider, model }) => `${provider.id}/${model.id}`)
        .join(" or ")}).`,
    };
  }
  return {
    ok: false,
    status: 400,
    message: `Model '${modelStr}' could not be resolved to a known transcription provider. Available: ${getAllTranscriptionModels()
      .map((model) => model.id)
      .join(", ")}.`,
  };
}

function listModelIds(provider: TranscriptionProvider): string[] {
  return provider.models.map((model) => `${provider.id}/${model.id}`);
}

/** Every transcription model as `provider/model`, for /v1/models. */
export function getAllTranscriptionModels(): { id: string; name: string; provider: string }[] {
  return Object.values(TRANSCRIPTION_PROVIDERS).flatMap((provider) =>
    provider.models.map((model) => ({
      id: `${provider.id}/${model.id}`,
      name: model.name,
      provider: provider.id,
    }))
  );
}

/**
 * The fast-transcription URL for an Azure Speech connection, or null when the configured
 * endpoint is not an https URL. Only the origin is kept, so a pasted path or query cannot
 * redirect the request.
 */
export function resolveAzureSpeechTranscribeUrl(rawEndpoint: unknown): string | null {
  const origin = resolveAzureSpeechOrigin(rawEndpoint);
  return origin
    ? `${origin}/speechtotext/transcriptions:transcribe?api-version=${AZURE_SPEECH_API_VERSION}`
    : null;
}

/** `Models - List Base Models`: a free, key-authenticated GET used to validate a connection. */
export function resolveAzureSpeechValidationUrl(rawEndpoint: unknown): string | null {
  const origin = resolveAzureSpeechOrigin(rawEndpoint);
  return origin
    ? `${origin}/speechtotext/models/base?top=1&api-version=${AZURE_SPEECH_API_VERSION}`
    : null;
}

function resolveAzureSpeechOrigin(rawEndpoint: unknown): string | null {
  if (typeof rawEndpoint !== "string" || !rawEndpoint.trim()) return null;
  try {
    const url = new URL(rawEndpoint.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
