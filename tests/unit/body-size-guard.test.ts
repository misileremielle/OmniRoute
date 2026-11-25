import test from "node:test";
import assert from "node:assert/strict";
import * as bodySizeGuard from "../../src/shared/middleware/bodySizeGuard.ts";
import {
  MAX_BODY_BYTES_IMPORT,
  MAX_BODY_BYTES_LLM_API,
  MAX_BODY_BYTES_TRANSCRIPTION,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
  getBodySizeLimit,
  checkBodySize,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import { requestBodyLimitMbToBytes } from "../../src/shared/constants/bodySize.ts";
import { MAX_TRANSCRIPTION_UPLOAD_BYTES } from "../../open-sse/config/transcriptionRegistry.ts";

test("body size guard public surface excludes the removed default MB helper", () => {
  assert.equal(Object.hasOwn(bodySizeGuard, "getDefaultRequestBodyLimitMb"), false);
  assert.equal(typeof bodySizeGuard.getBodySizeLimit, "function");
  assert.equal(typeof bodySizeGuard.checkBodySize, "function");
});

test("body size guard uses maxBodySizeMb from settings for regular API routes", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 100 }),
    requestBodyLimitMbToBytes(100)
  );
});

test("body size guard keeps dedicated upload limits as lower bounds", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 10 }),
    MAX_BODY_BYTES_LLM_API
  );
  assert.equal(
    getBodySizeLimit("/api/v1/chat/completions", { maxBodySizeMb: 10 }),
    MAX_BODY_BYTES_LLM_API
  );
  assert.equal(getBodySizeLimit("/api/v1/messages", { maxBodySizeMb: 10 }), MAX_BODY_BYTES_LLM_API);
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});

test("bounded body reader enforces actual bytes when Content-Length is absent", async () => {
  const request = new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }),
    // Node requires this for a streamed request body; no Content-Length is supplied.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    () => readRequestBodyWithLimit(request, 5),
    (err: unknown) => err instanceof RequestBodyTooLargeError && err.limit === 5
  );
});

/** A streamed request whose body is driven by `pull`; `cancel` may be made to never settle. */
function streamedRequest(source: UnderlyingDefaultSource<Uint8Array>) {
  return new Request("http://localhost/api/v1/audio/transcriptions", {
    method: "POST",
    body: new ReadableStream(source),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
const never = () => new Promise<void>(() => {});

test("bounded body reader gives up on a stalled body even if cancel never settles", async () => {
  const request = streamedRequest({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    pull: never,
    cancel: never,
  });
  const started = Date.now();
  await assert.rejects(
    () => readRequestBodyWithLimit(request, 100, { idleTimeoutMs: 50 }),
    (err: unknown) => err instanceof RequestBodyTimeoutError && err.reason === "idle"
  );
  assert.ok(Date.now() - started < 2000);
});

test("bounded body reader stops a trickling body at its total deadline", async () => {
  const request = streamedRequest({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(new Uint8Array([1]));
    },
  });
  await assert.rejects(
    () => readRequestBodyWithLimit(request, 10_000, { idleTimeoutMs: 1000, totalTimeoutMs: 150 }),
    (err: unknown) => err instanceof RequestBodyTimeoutError && err.reason === "total"
  );
});

test("bounded body reader refuses queued data once the deadline has passed", async () => {
  const request = streamedRequest({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await assert.rejects(
    () => readRequestBodyWithLimit(request, 100, { totalTimeoutMs: 0 }),
    (err: unknown) => err instanceof RequestBodyTimeoutError && err.reason === "total"
  );
});

test("bounded body reader answers too-large even if cancel never settles", async () => {
  const request = streamedRequest({
    pull(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel: never,
  });
  await assert.rejects(
    () => readRequestBodyWithLimit(request, 5),
    (err: unknown) => err instanceof RequestBodyTooLargeError
  );
});

test("bounded body reader with timeouts still returns a prompt body whole", async () => {
  const request = streamedRequest({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const body = await readRequestBodyWithLimit(request, 10, {
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
  });
  assert.deepEqual([...body], [1, 2, 3]);
});

test("bounded body reader rejects a dishonest small Content-Length by actual byte count", async () => {
  const request = new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-length": "1" },
    body: new Uint8Array([1, 2, 3, 4]),
  });

  await assert.rejects(() => readRequestBodyWithLimit(request, 3), RequestBodyTooLargeError);
});

test("checkBodySize reports the configured request limit in 413 responses", async () => {
  const limit = requestBodyLimitMbToBytes(100);
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(limit + 1) },
  });

  const response = checkBodySize(request, limit);

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /100 MB/);
});

test("/api/v1/responses route guard allows 15 MB agent payloads by default", () => {
  const fifteenMb = 15 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(fifteenMb) },
  });

  assert.equal(checkBodySize(request, getBodySizeLimit("/api/v1/responses")), null);
});

test("/api/v1/responses route guard rejects payloads above the LLM API floor", async () => {
  const tooBig = MAX_BODY_BYTES_LLM_API + 1;
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(tooBig) },
  });

  const response = checkBodySize(request, getBodySizeLimit("/api/v1/responses"));

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /50 MB/);
});

test("removed media routes no longer bypass the configured body-size limit", () => {
  const configuredLimit = requestBodyLimitMbToBytes(10);
  for (const pathname of [
    "/api/v1/images/generations",
    "/api/v1/images/edits",
    "/api/v1/videos/generations",
    "/api/v1/audio/speech",
    "/api/v1/audio/transcriptions/extra",
    "/api/v1/providers/openai/images/generations",
    "/api/v1/providers/openai/chat/completions",
    "/api/v1/providers/openai/embeddings",
  ]) {
    assert.equal(getBodySizeLimit(pathname, { maxBodySizeMb: 10 }), configuredLimit);
  }
});

test("audio transcription uploads get their own fixed limit, not the 10 MB default", () => {
  assert.equal(
    MAX_BODY_BYTES_TRANSCRIPTION,
    MAX_TRANSCRIPTION_UPLOAD_BYTES + 1024 * 1024,
    "room for one full upload plus the multipart framing"
  );
  for (const settings of [
    undefined,
    { maxBodySizeMb: 10 },
    { maxBodySizeMb: 500, savedMaxBodySizeMb: 500 },
    { maxBodySizeMb: 1, savedMaxBodySizeMb: 1 },
  ]) {
    assert.equal(
      getBodySizeLimit("/api/v1/audio/transcriptions", settings),
      MAX_BODY_BYTES_TRANSCRIPTION
    );
  }
});

test("a saved limit stays a lower bound for the dedicated import route", () => {
  assert.equal(
    getBodySizeLimit("/api/db-backups/import", { maxBodySizeMb: 1, savedMaxBodySizeMb: 1 }),
    MAX_BODY_BYTES_IMPORT
  );
});

test("a saved limit replaces the LLM route default, up or down", () => {
  for (const pathname of ["/api/v1/responses", "/api/v1/chat/completions"]) {
    assert.equal(
      getBodySizeLimit(pathname, { maxBodySizeMb: 10, savedMaxBodySizeMb: 10 }),
      requestBodyLimitMbToBytes(10)
    );
    assert.equal(
      getBodySizeLimit(pathname, { maxBodySizeMb: 100, savedMaxBodySizeMb: 100 }),
      requestBodyLimitMbToBytes(100)
    );
    assert.equal(
      getBodySizeLimit(pathname, { maxBodySizeMb: 10, savedMaxBodySizeMb: null }),
      MAX_BODY_BYTES_LLM_API
    );
  }
});
