import { sanitizeErrorMessage } from "../../utils/error.ts";

/** Project only the copy retained on a connection; routing still sees the raw failure. */
export function projectRetainedProviderFailureMessage(message: string): string {
  return sanitizeErrorMessage(message) || "Provider request failed";
}
