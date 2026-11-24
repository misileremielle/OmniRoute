import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestedLocale } from "../../src/i18n/resolveRequestedLocale.ts";
import { LOCALES as REAL_LOCALES, LOCALE_ALIASES as REAL_ALIASES } from "../../src/i18n/config.ts";

const LOCALES = ["en", "id", "uk-UA", "phi"] as const;
const ALIASES = { id: ["in"], "uk-UA": ["uk"], phi: ["fil", "tl"] } as const;

test("returns the locale itself when it is configured", () => {
  assert.equal(resolveRequestedLocale("uk-UA", LOCALES, ALIASES, "en"), "uk-UA");
});

test("resolves a legacy or bare alias stored in the cookie (in → id, uk → uk-UA)", () => {
  assert.equal(resolveRequestedLocale("in", LOCALES, ALIASES, "en"), "id");
  assert.equal(resolveRequestedLocale("uk", LOCALES, ALIASES, "en"), "uk-UA");
});

test("is case-insensitive and falls back when unknown or empty", () => {
  assert.equal(resolveRequestedLocale("UK-ua", LOCALES, ALIASES, "en"), "uk-UA");
  assert.equal(resolveRequestedLocale("xx", LOCALES, ALIASES, "en"), "en");
  assert.equal(resolveRequestedLocale("", LOCALES, ALIASES, "en"), "en");
});

// The fixtures above pin the resolver's behaviour; this one pins the shipped
// config/i18n.json wiring. The fork ships English only, so a NEXT_LOCALE cookie
// saved for a locale it removed must land on English.
test("the shipped config resolves a cookie for a removed locale to en", () => {
  assert.deepEqual([...REAL_LOCALES], ["en"]);
  for (const saved of ["id", "in", "pt-BR", "zh-CN"]) {
    assert.equal(resolveRequestedLocale(saved, REAL_LOCALES, REAL_ALIASES, "en"), "en", saved);
  }
});
