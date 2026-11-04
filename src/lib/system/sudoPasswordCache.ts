/**
 * Process-scoped sudo password cache for privileged system helpers (the
 * Tailscale tunnel install/funnel flow). Module-scoped — never exposed on
 * globalThis, never persisted.
 */
let cachedPassword: string | null = null;

export function getCachedPassword(): string | null {
  return cachedPassword;
}

export function setCachedPassword(pwd: string | null | undefined): void {
  cachedPassword = pwd || null;
}

export function clearCachedPassword(): void {
  cachedPassword = null;
}
