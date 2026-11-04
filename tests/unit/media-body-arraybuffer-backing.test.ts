import assert from "node:assert/strict";
import test from "node:test";
import { readPageResponseBody } from "../../open-sse/services/browserPool.ts";
import { fetchRemoteImage } from "@/shared/network/remoteImageFetch";

test("fetchRemoteImage returns an ArrayBuffer-backed buffer that new Blob accepts", async () => {
  const result = await fetchRemoteImage("https://cdn.example.com/image.png", {
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    guard: "public-only",
    lookup: async () => [{ address: "203.0.113.5", family: 4 }],
  });

  assert.ok(result.buffer.buffer instanceof ArrayBuffer, "image bytes must be ArrayBuffer-backed");
  // open-sse/handlers/imageGeneration.ts wraps this in `new Blob([…])` for the
  // Topaz multipart upload.
  assert.doesNotThrow(() => new Blob([result.buffer], { type: "image/png" }));
});

test("readPageResponseBody returns an ArrayBuffer-backed body", async () => {
  const fakeResponse = {
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    body: async () => Buffer.from('{"ok":true}'),
  };

  const captured = await readPageResponseBody(
    fakeResponse as unknown as Parameters<typeof readPageResponseBody>[0]
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.body.toString(), '{"ok":true}');
  // browserBackedChat.ts assigns this into a `Buffer.alloc(0)`-seeded local
  // that it later returns as the response body.
  assert.ok(captured.body.buffer instanceof ArrayBuffer);
});
