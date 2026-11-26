import { createHash } from "crypto";
import os from "os";

/**
 * Stable per-host device UUID, derived from the hostname + a per-purpose salt.
 *
 * Client-safe on purpose: this module touches only `crypto` and `os` (both
 * polyfilled for a client bundle), so anything reachable from a dashboard
 * component can build the same device identity the server does. The richer
 * `/etc/machine-id` probe lives in `machineId.ts` and pulls `fs`/`child_process`,
 * which is why it must not sit on a client path.
 *
 * Stability is the point: a fresh UUID per process would present every restart as
 * a brand-new device to the upstream, and so would a per-request one. The hostname
 * is stable across restarts and reboots, which is what "one CLI install" means.
 */
export function stableDeviceUuid(salt: string): string {
  let seed = "";
  try {
    seed = os.hostname().toLowerCase();
  } catch {
    // No hostname available — the salt alone still yields a stable value.
  }
  const hex = createHash("sha256")
    .update(seed + (salt || ""))
    .digest("hex");
  return formatUuidV4(hex);
}

/** Render a hex digest as a format-correct (if not random) UUIDv4. */
export function formatUuidV4(hex: string): string {
  const variantNibble = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variantNibble}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
