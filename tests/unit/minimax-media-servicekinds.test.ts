import test from "node:test";
import assert from "node:assert/strict";

const { getRegistryMediaKinds, resolveProviderServiceKinds, REGISTRY_MEDIA_KINDS } =
  await import("../../open-sse/config/mediaServiceKinds.ts");
const { AI_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

test("minimax and minimax-cn derive no removed media kinds from the registries", () => {
  assert.deepEqual(getRegistryMediaKinds("minimax"), []);
  assert.deepEqual(getRegistryMediaKinds("minimax-cn"), []);
});

test("representative embedding and OCR providers derive the expected kinds", () => {
  const cases: Record<string, string[]> = {
    openai: ["embedding"],
    cohere: ["embedding"],
    mistral: ["embedding", "ocr"],
  };
  for (const [id, expected] of Object.entries(cases)) {
    const derived = getRegistryMediaKinds(id);
    for (const kind of expected) {
      assert.ok(
        derived.includes(kind as never),
        `${id} should derive ${kind}; got ${derived.join(",")}`
      );
    }
  }
});

test("resolveProviderServiceKinds unions declared kinds with derived embedding and OCR kinds", () => {
  const merged = resolveProviderServiceKinds("mistral", ["llm"]);
  for (const expected of ["llm", "embedding", "ocr", "imageToText"]) {
    assert.ok(merged.includes(expected), `expected ${expected} in ${merged.join(",")}`);
  }
  const deduped = resolveProviderServiceKinds("openai", ["embedding"]);
  assert.equal(deduped.filter((k) => k === "embedding").length, 1);
});

test("ocr is a registry-backed media kind and mistral derives it", () => {
  assert.ok(
    (REGISTRY_MEDIA_KINDS as readonly string[]).includes("ocr"),
    "REGISTRY_MEDIA_KINDS should include ocr"
  );
  assert.ok(
    getRegistryMediaKinds("mistral").includes("ocr" as never),
    "mistral should derive the ocr media kind from OCR_PROVIDERS"
  );
  const merged = resolveProviderServiceKinds("mistral", ["llm"]);
  assert.ok(merged.includes("ocr"), `expected ocr in ${merged.join(",")}`);
});

test("derived kinds are always within the known media-kind set", () => {
  for (const id of Object.keys(AI_PROVIDERS)) {
    for (const kind of getRegistryMediaKinds(id)) {
      assert.ok(
        (REGISTRY_MEDIA_KINDS as readonly string[]).includes(kind),
        `${id} derived unknown kind ${kind}`
      );
    }
  }
});
