// Pure, shared helpers for provider credential copy (labels/hints/titles for
// the API-key and web-session-credential modals). Extracted out of
// providerPageHelpers.ts (Issue #3501 strangler-fig decomposition) — that leaf
// is frozen at its file-size cap, so this cohesive slice (message-translation
// utility + the add-credential modal title) lives here instead and
// is re-exported from providerPageHelpers.ts for backward compatibility. Leaf
// module — imports only from @/shared, @/lib and colocated sibling modules.
export type ProviderMessageTranslator = ((
  key: string,
  values?: Record<string, unknown>
) => string) & {
  has?: (key: string) => boolean;
};

export function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) {
    return t(key, values);
  }
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

export function getAddCredentialModalTitle(
  t: ProviderMessageTranslator,
  providerName: string
): string {
  return t("addProviderApiKeyTitle", { provider: providerName });
}
