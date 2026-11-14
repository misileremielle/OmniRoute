import assert from "node:assert/strict";
import test from "node:test";

import {
  FREE_MODEL_BUDGETS,
  computeFreeModelTotals,
} from "@omniroute/open-sse/config/freeModelCatalog.ts";
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";
import { AI_PROVIDERS } from "@/shared/constants/providers.ts";

/**
 * The OpenAI-compatible free-tier provider from the 2026-07 batch still in the fork (sealion).
 * The tests pin the decisions that are easy to break silently.
 */

const NEW_PROVIDERS = ["sealion"] as const;
const byProvider = (id: string) => FREE_MODEL_BUDGETS.filter((m) => m.provider === id);

test("each new provider is both routable and canonically registered", () => {
  for (const id of NEW_PROVIDERS) {
    assert.ok(REGISTRY[id], `${id} must exist in the execution REGISTRY`);
    assert.ok(AI_PROVIDERS[id], `${id} must exist as a canonical provider`);
    assert.equal(REGISTRY[id].format, "openai");
    assert.ok(byProvider(id).length > 0, `${id} must have free-catalog entries`);
  }
});

test("providers with no published token quota never inflate the headline", () => {
  // ainative ("claimed"), aion (per-day request cap), sealion (RPM only),
  // routeway (RPD): real free access, no verifiable monthly token figure.
  for (const id of ["sealion"]) {
    const rows = byProvider(id);
    assert.ok(
      rows.every((m) => m.monthlyTokens === 0 && m.creditTokens === 0),
      `${id} has no published token quota — it must not carry invented numbers`
    );
    assert.ok(rows.every((m) => m.freeType === "recurring-uncapped"));
  }
  const totals = computeFreeModelTotals();
  for (const id of ["sealion"]) {
    assert.ok(totals.uncappedProviders.includes(id), `${id} must surface as uncapped`);
  }
});

test("every catalog provider id still resolves to a canonical provider", () => {
  const unknown = [...new Set(FREE_MODEL_BUDGETS.map((m) => m.provider))].filter(
    (id) => !AI_PROVIDERS[id]
  );
  assert.deepEqual(unknown, [], `dangling catalog providers: ${unknown.join(", ")}`);
});
