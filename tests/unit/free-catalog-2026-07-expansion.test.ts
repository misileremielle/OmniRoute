import assert from "node:assert/strict";
import test from "node:test";

import {
  FREE_MODEL_BUDGETS,
  computeFreeModelTotals,
} from "@omniroute/open-sse/config/freeModelCatalog.ts";
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";
import { AI_PROVIDERS } from "@/shared/constants/providers.ts";

/**
 * 2026-07 expansion: providers whose free tier was documented upstream but never
 * mapped here. Each assertion pins a decision that is easy to silently undo.
 */

const byProvider = (id: string) => FREE_MODEL_BUDGETS.filter((m) => m.provider === id);

test("ovhcloud and aihorde are keyless (no API key required)", () => {
  for (const id of ["ovhcloud", "aihorde"]) {
    const rows = byProvider(id);
    assert.ok(rows.length > 0, `${id} must be in the free catalog`);
    assert.ok(
      rows.every((m) => m.freeType === "keyless"),
      `${id} free access needs no API key, so every row must be keyless`
    );
  }
});

test("providers without a published TOKEN quota never inflate the headline", () => {
  // These have a real free tier capped in REQUESTS (or a queue), not tokens.
  // Registering a guessed token figure is how a catalog starts lying.
  for (const id of ["agnes", "glm"]) {
    const rows = byProvider(id);
    assert.ok(rows.length > 0, `${id} must be in the free catalog`);
    assert.ok(
      rows.every((m) => m.monthlyTokens === 0 && m.creditTokens === 0),
      `${id} has no published token quota — it must not carry invented numbers`
    );
    assert.ok(rows.every((m) => m.freeType === "recurring-uncapped"));
  }

  const totals = computeFreeModelTotals();
  for (const id of ["agnes", "glm"]) {
    assert.ok(
      totals.uncappedProviders.includes(id),
      `${id} must still be surfaced as an uncapped provider`
    );
  }
});

test("new providers are routable and canonically registered", () => {
  for (const id of ["aihorde"]) {
    assert.ok(REGISTRY[id], `${id} must exist in the execution REGISTRY`);
    assert.ok(AI_PROVIDERS[id], `${id} must exist as a canonical provider`);
  }
  // aihorde reaches the volunteer queue with its documented anonymous key.
  assert.equal(REGISTRY.aihorde.anonymousApiKey, "0000000000");
  // The volunteer queue is minutes-slow; the default timeout would abort it.
  assert.equal(REGISTRY.aihorde.timeoutMs, 120_000);
});

test("every catalog provider id resolves to a canonical provider", () => {
  const unknown = [...new Set(FREE_MODEL_BUDGETS.map((m) => m.provider))].filter(
    (id) => !AI_PROVIDERS[id]
  );
  assert.deepEqual(
    unknown,
    [],
    `free catalog references providers that do not exist: ${unknown.join(", ")}`
  );
});
