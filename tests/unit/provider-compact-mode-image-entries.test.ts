// Compact mode must list image providers like the full page does. The fork's feature cleanup
// (dc211b63de) dropped `imageProviderEntries` together with the removed audio/video groups,
// so image providers vanished from the compact "apikey" category and the "all" view while
// the full page still rendered them.
import test from "node:test";
import assert from "node:assert/strict";

const { buildCompactProviderEntriesForPage } =
  await import("../../src/app/(dashboard)/dashboard/providers/providerCompactMode.ts");

type Entry = Parameters<
  typeof buildCompactProviderEntriesForPage
>[0]["imageProviderEntries"][number];
const entry = (providerId: string): Entry => ({
  providerId,
  provider: {},
  stats: {} as Entry["stats"],
  displayAuthType: "apikey",
  toggleAuthType: "apikey",
});

function options(activeCategory: string) {
  const empty: Entry[] = [];
  return {
    activeCategory,
    showFreeOnly: false,
    freeSectionEntries: empty,
    compatibleProviderEntries: empty,
    oauthProviderEntries: empty,
    ideProviderEntries: empty,
    noAuthEntries: empty,
    upstreamProxyEntries: empty,
    llmProviderEntries: [entry("llm-provider")],
    aggregatorProviderEntries: empty,
    enterpriseProviderEntries: empty,
    embeddingRerankProviderEntries: empty,
    imageProviderEntries: [entry("image-provider")],
    webCookieProviderEntries: empty,
    searchProviderEntries: empty,
    webFetchEntries: empty,
    localProviderEntries: empty,
    cloudAgentProviderEntries: empty,
  };
}

const ids = (category: string) =>
  buildCompactProviderEntriesForPage(options(category)).map((e) => e.providerId);

test("compact apikey category includes image providers", () => {
  assert.deepEqual(ids("apikey"), ["llm-provider", "image-provider"]);
});

test("compact all view includes image providers", () => {
  assert.ok(ids("all").includes("image-provider"));
});

test("a category without image providers does not pull them in", () => {
  assert.deepEqual(ids("search"), []);
});
