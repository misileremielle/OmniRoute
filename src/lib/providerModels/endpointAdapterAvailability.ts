/**
 * Provider endpoint adapter evidence (#16929).
 *
 * A model can advertise an endpoint without OmniRoute having a handler for it.
 * Static registrations are positive evidence. Unknown dynamic/gateway providers
 * remain "unknown", not falsely labeled supported or rejected.
 */
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry";
import { getEmbeddingProvider } from "@omniroute/open-sse/config/embeddingRegistry";
import { getRerankProvider } from "@omniroute/open-sse/config/rerankRegistry";
import {
  isTrustedEndpointCapabilitySource,
  normalizeModelSupportedEndpoints,
} from "@/shared/constants/modelSupportedEndpoints";

export type EndpointAdapterStatus = "available" | "unavailable" | "unknown";
export type EndpointAdapterStatuses = Record<string, EndpointAdapterStatus>;

export function getRegisteredEndpointAdapterStatuses(provider: string): EndpointAdapterStatuses {
  const hasChatRegistry = Boolean(getRegistryEntry(provider));
  const status = (present: boolean, knownAbsent = false): EndpointAdapterStatus =>
    present ? "available" : knownAbsent ? "unavailable" : "unknown";
  return {
    chat: status(hasChatRegistry),
    responses: status(hasChatRegistry),
    embeddings: status(Boolean(getEmbeddingProvider(provider))),
    rerank: status(Boolean(getRerankProvider(provider))),
    // Media endpoints no longer exist; rows still tagged with them are unrunnable.
    images: "unavailable",
    "images-generations": "unavailable",
    videos: "unavailable",
    music: "unavailable",
    "audio-speech": "unavailable",
    "audio-transcriptions": "unavailable",
  };
}

/**
 * True when a model's trusted endpoint tags all point at endpoints this provider
 * has no adapter for. Missing/defaulted provenance and "unknown" adapters never
 * count as unrunnable.
 */
export function hasNoRunnableEndpointAdapter(
  provider: string,
  model:
    | { id?: string; supportedEndpoints?: readonly string[]; endpointCapabilitySource?: unknown }
    | null
    | undefined
): boolean {
  if (!model?.supportedEndpoints?.length) return false;
  if (!isTrustedEndpointCapabilitySource(model.endpointCapabilitySource)) return false;
  const endpoints = normalizeModelSupportedEndpoints(model.supportedEndpoints);
  if (endpoints.length === 0) return false;
  const adapters = getRegisteredEndpointAdapterStatuses(provider);
  return endpoints.every((endpoint) => adapters[endpoint] === "unavailable");
}
