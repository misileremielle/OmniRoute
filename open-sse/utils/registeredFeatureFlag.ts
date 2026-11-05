// The server feature-flag resolver (DB override > env > definition default) is
// published on globalThis by src/shared/utils/featureFlagResolverBridge.ts under
// this process-wide symbol. Reading it here keeps open-sse free of a new src
// import (boundary ratchet).
const FEATURE_FLAG_RESOLVER_KEY = Symbol.for("omniroute.featureFlagResolver");

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve a boolean feature flag from open-sse. Without a registered server
 * resolver the environment variable decides. Fails closed when the resolver throws.
 */
export function isRegisteredFeatureFlagEnabled(
  key: string,
  env: EnvLike = typeof process === "undefined" ? {} : process.env
): boolean {
  try {
    const resolver = (globalThis as Record<symbol, unknown>)[FEATURE_FLAG_RESOLVER_KEY];
    if (typeof resolver === "function") {
      return (resolver as (flag: string) => boolean)(key) === true;
    }
    const raw = env[key];
    return raw === "true" || raw === "1" || raw === "yes";
  } catch {
    return false;
  }
}

/**
 * Same as isRegisteredFeatureFlagEnabled for a flag whose definition default is ON. Without a
 * registered server resolver an unset environment variable means "on"; only an explicit
 * false/0/no turns it off. Fails closed when the resolver throws.
 */
export function isRegisteredDefaultOnFeatureFlagEnabled(
  key: string,
  env: EnvLike = typeof process === "undefined" ? {} : process.env
): boolean {
  try {
    const resolver = (globalThis as Record<symbol, unknown>)[FEATURE_FLAG_RESOLVER_KEY];
    if (typeof resolver === "function") {
      return (resolver as (flag: string) => boolean)(key) === true;
    }
    const raw = env[key]?.trim().toLowerCase();
    return !(raw === "false" || raw === "0" || raw === "no" || raw === "off");
  } catch {
    return false;
  }
}
