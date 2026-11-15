// tests/unit/compression/ionizerEngine.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { ionizerEngine } from "../../../open-sse/services/compression/engines/ionizer/index.ts";

const bigArray = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ i, v: `row-${i}` })));

test("ionizer enabled: oversized homogeneous array → inline sample + omitted-rows marker", () => {
  const body = { messages: [{ role: "user", content: bigArray }] };
  const res = ionizerEngine.apply(body, { stepConfig: {}, principalId: "p1" });
  assert.equal(res.compressed, true);
  const content = (res.body.messages as Array<{ content: string }>)[0].content;
  const m = content.match(/\[ionizer: kept (\d+)\/400 rows; (\d+) omitted\]$/);
  assert.ok(m, content.slice(-80));
  assert.equal(Number(m[1]) + Number(m[2]), 400);
  assert.ok(!content.includes("retrieve"), "no retrieve hash: the dropped rows are not stored");
});

test("ionizer disabled via enabled:false → no-op", () => {
  const body = { messages: [{ role: "user", content: bigArray }] };
  const res = ionizerEngine.apply(body, { stepConfig: { enabled: false }, principalId: "p1" });
  assert.equal(res.compressed, false);
});

test("small array / non-array / non-homogeneous → no-op", () => {
  const small = { messages: [{ role: "user", content: JSON.stringify([{ a: 1 }, { a: 2 }]) }] };
  assert.equal(ionizerEngine.apply(small, { stepConfig: {} }).compressed, false);
  const notArr = { messages: [{ role: "user", content: '{"a":1}' }] };
  assert.equal(ionizerEngine.apply(notArr, { stepConfig: {} }).compressed, false);
  const mixed = { messages: [{ role: "user", content: JSON.stringify([{ a: 1 }, 2, "x"]) }] };
  assert.equal(ionizerEngine.apply(mixed, { stepConfig: {} }).compressed, false);
});

test("engine declares sampling:true and is registered", () => {
  assert.equal(ionizerEngine.sampling, true);
  assert.equal(ionizerEngine.id, "ionizer");
});
