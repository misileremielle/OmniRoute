import test from "node:test";
import assert from "node:assert/strict";

// 9router#2233: complete the SenseNova (商汤日日新) provider for its free Token Plan.
// The chat provider already existed but was missing the `deepseek-v4-flash` chat model
// and — the core ask — the Text-to-Image model `sensenova-u1-fast`, which cannot work
// through the chat path: it must be registered as an IMAGE provider so requests route
// to `/v1/images/generations` via the OpenAI-compatible image handler.

const { sensenovaProvider } =
  await import("../../open-sse/config/providers/registry/sensenova/index.ts");

test("SenseNova chat registry includes the deepseek-v4-flash chat model", () => {
  const ids = sensenovaProvider.models.map((m) => m.id);
  assert.ok(
    ids.includes("deepseek-v4-flash"),
    `expected deepseek-v4-flash in SenseNova chat models, got: ${ids.join(", ")}`
  );
});

test("SenseNova chat registry does NOT carry the image model (image goes to the image registry)", () => {
  const ids = sensenovaProvider.models.map((m) => m.id.toLowerCase());
  assert.ok(
    !ids.includes("sensenova-u1-fast"),
    "the text-to-image model must live in the image registry, not the chat registry"
  );
});
