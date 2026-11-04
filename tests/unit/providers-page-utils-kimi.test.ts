// Kimi hidden-alias guard: kimi-coding-apikey and the legacy "kimi" alias are
// hiddenFromDashboard and must never render their own provider card.
import test from "node:test";
import assert from "node:assert/strict";

const providerPageUtils =
  await import("../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts");

test("kimi-coding-apikey and kimi never render as their own dashboard card in ANY section (hiddenFromDashboard)", () => {
  const getProviderStats = () => ({ total: 0 });
  const categories = [
    "no-auth",
    "oauth",
    "web-cookie",
    "local",
    "search",
    "upstream-proxy",
    "apikey",
  ] as const;

  for (const category of categories) {
    const entries = providerPageUtils.buildStaticProviderEntries(category, getProviderStats);
    assert.equal(
      entries.some((e) => e.providerId === "kimi-coding-apikey"),
      false,
      `kimi-coding-apikey must not appear as its own card in the "${category}" category`
    );
    assert.equal(
      entries.some((e) => e.providerId === "kimi"),
      false,
      `kimi (legacy alias) must not appear as its own card in the "${category}" category`
    );
  }
});
