import { z } from "zod";

const list = z.array(z.string()).max(100);
const supported = new Set(["text", "image", "audio", "video", "pdf", "file"]);

/** Explicit upstream declarations only; no model-name inference. */
export function declaredInputModalities(
  record: Record<string, unknown>,
  _providerId?: string
): string[] | undefined {
  const architecture = record.architecture as Record<string, unknown> | undefined;
  const parsed = list.safeParse(
    record.supportedInputTypes ?? record.input_modalities ?? architecture?.input_modalities
  );
  if (parsed.success)
    return [...new Set(parsed.data.map((v) => v.toLowerCase()).filter((v) => supported.has(v)))];
  return undefined;
}
