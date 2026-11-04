/**
 * chatCore tool-call format mapper (Quality Gate v2 / Fase 9 — chatCore god-file decomposition, #3501).
 *
 * Pure mapper extracted from chatCore: translates the request wire format into the model id used
 * to read tool calls out of a response. Side-effect-free; behaviour is
 * byte-identical to the previous module-level functions.
 */

import { FORMATS } from "../../translator/formats.ts";

export function getToolCallModelIdForFormat(format: string): string {
  switch (format) {
    case FORMATS.CLAUDE:
      return "claude";
    case FORMATS.GEMINI:
      return "gemini";
    default:
      return "openai";
  }
}
