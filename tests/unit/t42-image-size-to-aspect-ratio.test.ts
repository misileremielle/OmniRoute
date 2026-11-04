import test from "node:test";
import assert from "node:assert/strict";

const { mapImageSize } = await import("../../open-sse/translator/image/sizeMapper.ts");

test("T42: size mapper converts OpenAI sizes and preserves direct aspect ratios", () => {
  assert.equal(mapImageSize("1024x1024"), "1:1");
  assert.equal(mapImageSize("1792x1024"), "16:9");
  assert.equal(mapImageSize("16:9"), "16:9");
  assert.equal(mapImageSize("333x777"), "1:1");
  assert.equal(mapImageSize(undefined), "1:1");
});
