/**
 * Deep-clone a request body for a per-attempt mutable copy, without duplicating strings.
 *
 * `structuredClone()` serializes every string into its transfer buffer and builds a new
 * one on the other side, so a body carrying multi-MB base64 images / audio or a long
 * chat history is copied in full for every upstream attempt and fallback. JS strings
 * are immutable, so sharing them between the original and the copy cannot leak a
 * mutation; only containers need to be fresh for attempt isolation.
 *
 * Contract (same observable result as `structuredClone` for request bodies):
 * - plain objects (prototype `Object.prototype` or `null`) and arrays are copied
 *   recursively — own enumerable string keys, like `structuredClone`;
 * - primitives (strings included) are shared as-is;
 * - shared references and cycles are preserved through a `seen` map;
 * - anything else (typed arrays, Buffer, Date, Map, Set, RegExp, class instances,
 *   functions) is handed to `structuredClone`, so it is cloned — or throws
 *   `DataCloneError` — exactly as before.
 */
export function cloneRequestBody<T>(value: T): T {
  return cloneInner(value, new Map()) as T;
}

function cloneInner(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") return structuredClone(value);
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return structuredClone(value);
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      // Holes become undefined, matching JSON-shaped request bodies.
      out[i] = cloneInner(value[i], seen);
    }
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const cloned = structuredClone(value);
    seen.set(value, cloned);
    return cloned;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    out[key] = cloneInner((value as Record<string, unknown>)[key], seen);
  }
  return out;
}
