/**
 * Decode a POST /v1/systemone request body the way the TypeSafe SDK sends it,
 * so OmniRoute can stand in for api.typesafe.ai (TYPESAFE_BASE_URL / baseURL):
 *
 *  - `Content-Encoding: zstd` — the SDK compresses bodies >= 1 KiB with zstd by
 *    default on Node >= 22.15; gzip / deflate / br are accepted too.
 *  - `multipart/form-data` — requests with image assets: a `request` part holding
 *    the JSON payload, then one file part per asset (named by `assets[alias].part`).
 *  - plain `application/json`.
 *
 * Decoding is bounded (MAX_DECODED_BYTES) so a compressed body cannot expand
 * without limit.
 */

import zlib from "node:zlib";

export const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** A non-`request` multipart part, forwarded upstream byte-for-byte. */
export interface SystemOneAssetPart {
  name: string;
  filename: string | null;
  contentType: string;
  data: Uint8Array;
}

export type DecodedSystemOneRequest =
  | { ok: true; payload: unknown; assetParts: SystemOneAssetPart[] }
  | { ok: false; status: number; message: string };

function decompress(raw: Uint8Array, encoding: string): Uint8Array {
  const options = { maxOutputLength: MAX_DECODED_BYTES };
  switch (encoding) {
    case "":
    case "identity":
      return raw;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(raw, options);
    case "deflate":
      return zlib.inflateSync(raw, options);
    case "br":
      return zlib.brotliDecompressSync(raw, options);
    case "zstd": {
      const zstd = (zlib as { zstdDecompressSync?: typeof zlib.gunzipSync }).zstdDecompressSync;
      if (typeof zstd !== "function") {
        throw new UnsupportedEncodingError("zstd request bodies need Node.js >= 22.15");
      }
      return zstd(raw, options);
    }
    default:
      throw new UnsupportedEncodingError(`Unsupported Content-Encoding: ${encoding}`);
  }
}

class UnsupportedEncodingError extends Error {}

async function readMultipart(
  body: Uint8Array,
  contentType: string
): Promise<DecodedSystemOneRequest> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return { ok: false, status: 400, message: "Invalid multipart/form-data body" };
  }
  const requestPart = form.get("request");
  if (requestPart === null) {
    return { ok: false, status: 400, message: 'multipart body has no "request" part' };
  }
  let payload: unknown;
  try {
    const text = typeof requestPart === "string" ? requestPart : await requestPart.text();
    payload = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: 'multipart "request" part is not valid JSON' };
  }
  const assetParts: SystemOneAssetPart[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "request") continue;
    if (typeof value === "string") {
      assetParts.push({
        name,
        filename: null,
        contentType: "text/plain",
        data: new TextEncoder().encode(value),
      });
      continue;
    }
    assetParts.push({
      name,
      filename: value.name || null,
      contentType: value.type || "application/octet-stream",
      data: new Uint8Array(await value.arrayBuffer()),
    });
  }
  return { ok: true, payload, assetParts };
}

export async function decodeSystemOneRequest(request: Request): Promise<DecodedSystemOneRequest> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await request.arrayBuffer());
  } catch {
    return { ok: false, status: 400, message: "Unable to read request body" };
  }

  const encoding = (request.headers.get("content-encoding") || "").trim().toLowerCase();
  let body: Uint8Array;
  try {
    body = decompress(raw, encoding);
  } catch (error) {
    if (error instanceof UnsupportedEncodingError) {
      return { ok: false, status: 415, message: error.message };
    }
    const tooLarge = (error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE";
    return tooLarge
      ? { ok: false, status: 413, message: "Decoded request body is too large" }
      : { ok: false, status: 400, message: `Invalid ${encoding} request body` };
  }

  const contentType = request.headers.get("content-type") || "";
  if (/^multipart\/form-data/i.test(contentType)) {
    return readMultipart(body, contentType);
  }

  try {
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(body)), assetParts: [] };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }
}
