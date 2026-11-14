// Text the caller or an upstream model controls goes through tag scanners before any request is
// made. The scanners used to be single regexes with overlapping whitespace classes, which are
// quadratic (or worse) on a long run of newlines or spaces, so one request could stall the
// event loop for every other client. These tests pin the results and the running time.
import test from "node:test";
import assert from "node:assert/strict";

const { findTagBlocks } = await import("../../open-sse/utils/tagBlocks.ts");
const webTools = await import("../../open-sse/translator/webTools.ts");

function elapsedMs(run: () => void): number {
  const start = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

test("findTagBlocks returns blocks in order with their bounds and untrimmed inner text", () => {
  const text = "a<x> one </x>b<x>two</x>c";
  const blocks = findTagBlocks(text, /<x>/g, /<\/x>/g);
  assert.deepEqual(
    blocks.map((b) => [b.start, b.end, b.inner]),
    [
      [1, 13, " one "],
      [14, 24, "two"],
    ]
  );
});

test("findTagBlocks stops at an opening tag that has no closing tag after it", () => {
  assert.deepEqual(findTagBlocks("<x>a</x><x>b", /<x>/g, /<\/x>/g).length, 1);
  assert.deepEqual(findTagBlocks("<x><x><x>", /<x>/g, /<\/x>/g), []);
});

test("parseToolCallsFromText keeps parsing <tool> and <tool_call ...> blocks and stays fast on hostile text", () => {
  const good = webTools.parseToolCallsFromText(
    'hi <tool>{"name":"a","arguments":{}}</tool> and <tool_call name="b">{"name":"b","arguments":{}}</tool_call>'
  );
  assert.deepEqual(
    good.toolCalls?.map((c: { function: { name: string } }) => c.function.name),
    ["a", "b"]
  );

  for (const hostile of [
    "<tool>" + " ".repeat(3_000),
    "<tool_call " + " ".repeat(3_000),
    "<tool>".repeat(20_000),
    "<tool_call>".repeat(20_000),
    // Many opening tags that never reach a `>`: each one used to scan to the end of the text.
    "<tool_call ".repeat(20_000),
  ]) {
    assert.ok(
      elapsedMs(() => webTools.parseToolCallsFromText(hostile)) < 500,
      hostile.slice(0, 20)
    );
  }
});
