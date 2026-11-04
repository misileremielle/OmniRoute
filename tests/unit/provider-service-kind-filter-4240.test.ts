/**
 * #4240 — Category (serviceKind) filter on /dashboard/providers.
 *
 * filterConfiguredProviderEntries gains a `serviceKindFilter` argument that keeps
 * only providers whose serviceKinds — declared OR registry-derived (image/video/
 * music/tts/stt/embedding) — include the selected kind, composing with the
 * existing configured-only / free / search predicates.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { filterConfiguredProviderEntries } =
  await import("../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts");
const { getProviderServiceKinds } = await import("../../src/lib/providers/serviceKindIndex.ts");

type Entry = {
  providerId: string;
  provider: { name: string; serviceKinds?: string[] };
  stats: { total: number };
  displayAuthType: "apikey";
  toggleAuthType: "apikey";
};

function entry(providerId: string, name: string, total: number): Entry {
  return {
    providerId,
    provider: { name },
    stats: { total },
    displayAuthType: "apikey",
    toggleAuthType: "apikey",
  };
}

// openai → embedding, jina-ai → embedding, mistral → embedding/imageToText, anthropic → none
// (all registry-derived; none declare serviceKinds explicitly here)
const ENTRIES: Entry[] = [
  entry("openai", "OpenAI", 1),
  entry("jina-ai", "Jina AI", 0),
  entry("mistral", "Mistral", 1),
  entry("anthropic", "Anthropic", 1),
];

function ids(list: Entry[]): string[] {
  return list.map((e) => e.providerId).sort();
}

test("serviceKindFilter keeps only providers whose (registry-derived) kinds include it", () => {
  const out = filterConfiguredProviderEntries(ENTRIES, false, "", false, "", "embedding");
  assert.deepEqual(ids(out), ["jina-ai", "mistral", "openai"]);
});

test("a registry-derived kind is resolved even with no declared serviceKinds (#4240)", () => {
  assert.ok(getProviderServiceKinds("mistral", undefined).includes("imageToText"));
  assert.ok(getProviderServiceKinds("openai", undefined).includes("embedding"));
  // a pure declared kind still works through the union
  assert.ok(getProviderServiceKinds("openai", ["llm"]).includes("llm"));
});

test("serviceKindFilter composes with showConfiguredOnly (intersection)", () => {
  // embedding → {openai, jina-ai, mistral}; configured-only drops jina-ai (stats.total === 0)
  const out = filterConfiguredProviderEntries(ENTRIES, true, "", false, "", "embedding");
  assert.deepEqual(ids(out), ["mistral", "openai"]);
});

test("serviceKindFilter composes with the search query (intersection)", () => {
  // embedding → {openai, jina-ai, mistral}; search "jina" narrows to jina-ai only
  const out = filterConfiguredProviderEntries(ENTRIES, false, "jina", false, "", "embedding");
  assert.deepEqual(ids(out), ["jina-ai"]);
});

test("a null/undefined serviceKindFilter leaves the list unchanged", () => {
  const out = filterConfiguredProviderEntries(ENTRIES, false, "", false, "", null);
  assert.deepEqual(ids(out), ids(ENTRIES));
  const out2 = filterConfiguredProviderEntries(ENTRIES, false, "", false, "");
  assert.deepEqual(ids(out2), ids(ENTRIES));
});

test("serviceKindFilter=imageToText keeps only ocr providers", () => {
  const out = filterConfiguredProviderEntries(ENTRIES, false, "", false, "", "imageToText");
  assert.deepEqual(ids(out), ["mistral"]);
});
