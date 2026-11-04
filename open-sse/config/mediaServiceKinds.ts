/**
 * Media serviceKinds — derived from the backend registries.
 *
 * The dashboard lists a provider under a service kind when the provider supports
 * it.
 *
 * This module makes the registries the single source of truth: a provider that
 * appears as a key in a media registry supports that kind, full stop. The UI
 * derives membership from here instead of duplicating it by hand, so adding a
 * provider to a registry automatically surfaces it — no second edit, no drift.
 *
 * `imageToText` is additionally derived from `OCR_PROVIDERS` (see
 * `resolveProviderServiceKinds`): a provider registered in the OCR registry gets
 * `imageToText` for free, no manual `serviceKinds` edit needed. Kinds without any
 * backing registry (webSearch, webFetch, llm) are still declared explicitly via
 * `serviceKinds` on the provider entry; callers union declared + derived sources.
 */
import { EMBEDDING_PROVIDERS } from "./embeddingRegistry.ts";
import { OCR_PROVIDERS } from "./ocrRegistry.ts";

/** Media kinds whose provider membership is defined by a backend registry. */
export const MEDIA_KIND_REGISTRIES = {
  embedding: EMBEDDING_PROVIDERS,
  ocr: OCR_PROVIDERS,
} as const satisfies Record<string, Record<string, unknown>>;

export type RegistryMediaKind = keyof typeof MEDIA_KIND_REGISTRIES;

export const REGISTRY_MEDIA_KINDS: readonly RegistryMediaKind[] = Object.freeze(
  Object.keys(MEDIA_KIND_REGISTRIES) as RegistryMediaKind[]
);

/**
 * Media serviceKinds a provider supports, derived from the backend registries.
 * Returns the kinds (e.g. `["embedding","ocr"]`) for which `providerId`
 * appears as a registry key. Empty array if the provider serves no media.
 */
export function getRegistryMediaKinds(providerId: string): RegistryMediaKind[] {
  const kinds: RegistryMediaKind[] = [];
  for (const kind of REGISTRY_MEDIA_KINDS) {
    if (Object.prototype.hasOwnProperty.call(MEDIA_KIND_REGISTRIES[kind], providerId)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * Full set of serviceKinds for a provider: the explicitly declared ones (llm,
 * web*, imageToText) unioned with the media kinds derived from the registries,
 * plus `imageToText` derived from the OCR registry when not already declared.
 */
export function resolveProviderServiceKinds(
  providerId: string,
  declared: readonly string[] | undefined
): string[] {
  const set = new Set<string>(declared ?? []);
  for (const kind of getRegistryMediaKinds(providerId)) set.add(kind);
  if (Object.prototype.hasOwnProperty.call(OCR_PROVIDERS, providerId)) {
    set.add("imageToText");
  }
  return [...set];
}
