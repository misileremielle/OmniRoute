import test from "node:test";
import assert from "node:assert/strict";
import * as bodySizeGuard from "../../src/shared/middleware/bodySizeGuard.ts";
import {
  MAX_BODY_BYTES_FILE,
  MAX_BODY_BYTES_LLM_API,
  RequestBodyTooLargeError,
  readRequestBodyWithLimit,
  getBodySizeLimit,
  checkBodySize,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import { requestBodyLimitMbToBytes } from "../../src/shared/constants/bodySize.ts";

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
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});

test("bounded body reader enforces actual bytes when Content-Length is absent", async () => {
  const request = new Request("http://localhost/api/v1/files", {
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

test("bounded body reader rejects a dishonest small Content-Length by actual byte count", async () => {
  const request = new Request("http://localhost/api/v1/files", {
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

test("/api/v1/files route has 512 MB dedicated limit floor", () => {
  const limit = getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 1 });
  assert.equal(limit, MAX_BODY_BYTES_FILE);
});

test("/api/v1/files route guard allows 500 MB file upload", () => {
  const thirtyMb = 500 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(thirtyMb) },
  });
  assert.equal(
    checkBodySize(request, getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 10 })),
    null
  );
});

test("/api/v1/files route guard rejects >512 MB file upload", async () => {
  const tooBig = 600 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(tooBig) },
  });
  const response = checkBodySize(request, getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 10 }));
  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("/api/v1/files route guard allows 15 MB (10 MB+ real-world scenario)", () => {
  const fifteenMb = 15 * 1024 * 1024;
  const request = new Request("http://localhost/api/v1/files", {
    method: "POST",
    headers: { "content-length": String(fifteenMb) },
  });
  assert.equal(checkBodySize(request, getBodySizeLimit("/api/v1/files")), null);
});

test("removed media routes no longer bypass the configured body-size limit", () => {
  const configuredLimit = requestBodyLimitMbToBytes(10);
  for (const pathname of [
    "/api/v1/images/generations",
    "/api/v1/images/edits",
    "/api/v1/videos/generations",
    "/api/v1/audio/transcriptions",
    "/api/v1/providers/openai/images/generations",
    "/api/v1/providers/openai/chat/completions",
    "/api/v1/providers/openai/embeddings",
  ]) {
    assert.equal(getBodySizeLimit(pathname, { maxBodySizeMb: 10 }), configuredLimit);
  }
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

test("a saved limit stays a lower bound for the dedicated upload routes", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/files", { maxBodySizeMb: 1, savedMaxBodySizeMb: 1 }),
    MAX_BODY_BYTES_FILE
  );
});
