import test from "node:test";
import assert from "node:assert/strict";

import { cloneRequestBody } from "../../open-sse/utils/cloneRequestBody.ts";

// prepareUpstreamBody() deep-copies the translated body for every upstream attempt
// because its normalizers mutate nested fields in place. structuredClone() also
// re-copied every string (multi-MB base64 images, long histories) per attempt;
// cloneRequestBody() keeps containers fresh but shares immutable strings.

test("cloneRequestBody gives fresh containers with equal content", () => {
  const image = `data:image/png;base64,${"A".repeat(1024)}`;
  const body = {
    model: "m",
    temperature: 0.2,
    stream: true,
    stop: null,
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: image } }] },
      { role: "assistant", content: "hi" },
    ],
  };
  const copy = cloneRequestBody(body);
  assert.deepEqual(copy, body);
  assert.notEqual(copy, body);
  assert.notEqual(copy.messages, body.messages);
  assert.notEqual(copy.messages[0], body.messages[0]);
  assert.notEqual(copy.messages[0].content[0], body.messages[0].content[0]);

  // Mutating the copy at any depth never reaches the original.
  (
    copy.messages[0].content[0] as { image_url: { url: string; detail?: string } }
  ).image_url.detail = "low";
  copy.messages.push({ role: "user", content: "extra" });
  delete (copy as { temperature?: number }).temperature;
  assert.equal("detail" in body.messages[0].content[0].image_url, false);
  assert.equal(body.messages.length, 2);
  assert.equal(body.temperature, 0.2);
});

test("cloneRequestBody preserves shared references and cycles like structuredClone", () => {
  const shared = { type: "text", text: "same" };
  const body: Record<string, unknown> = { a: shared, b: [shared] };
  body.self = body;
  const copy = cloneRequestBody(body) as Record<string, unknown>;
  assert.equal(copy.self, copy);
  assert.equal(copy.a, (copy.b as unknown[])[0]);
  assert.notEqual(copy.a, shared);
});

test("cloneRequestBody delegates non-plain values to structuredClone", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const when = new Date(0);
  const nullProto = Object.assign(Object.create(null), { k: "v" });
  const copy = cloneRequestBody({ bytes, when, nullProto, map: new Map([["x", 1]]) });
  assert.ok(copy.bytes instanceof Uint8Array);
  assert.notEqual(copy.bytes, bytes);
  assert.deepEqual([...copy.bytes], [1, 2, 3]);
  assert.ok(copy.when instanceof Date);
  assert.notEqual(copy.when, when);
  assert.equal(copy.when.getTime(), 0);
  assert.equal(Object.getPrototypeOf(copy.nullProto), Object.prototype);
  assert.equal(copy.nullProto.k, "v");
  assert.equal(copy.map.get("x"), 1);
  assert.throws(() => cloneRequestBody({ fn: () => 1 }), { name: "DataCloneError" });
});
