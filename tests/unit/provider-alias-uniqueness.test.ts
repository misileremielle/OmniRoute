/**
 * Provider alias uniqueness — no two provider IDs may share the same short alias.
 *
 * Before this guard, three aliases collided in the registry and the LAST entry in
 * iteration order silently won, emitting a startup warning and shadowing a real
 * provider:
 *   - "kimi" → kimi-web (shadowed the kimi provider that gained a dedicated executor)
 *   - "hc"   → the provider that held it shadowed huggingchat (it was later
 *     removed entirely, #11176; huggingchat keeps its own id as alias)
 *
 * The decision: the primary provider keeps the short alias; the web/secondary
 * variant takes its own id as alias. This test pins both the global uniqueness
 * invariant (so future additions can't silently re-collide) and the specific
 * resolutions for the affected providers, across BOTH alias sources
 * (open-sse registry + src/shared providers map).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.ts";
import { resolveProviderId, getProviderAlias } from "../../src/shared/constants/providers.ts";

test("no two provider IDs share the same alias in the open-sse registry", () => {
  const aliasToIds = new Map<string, string[]>();
  for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
    const ids = aliasToIds.get(alias) ?? [];
    ids.push(id);
    aliasToIds.set(alias, ids);
  }

  const collisions = [...aliasToIds.entries()].filter(([, ids]) => ids.length > 1);
  assert.deepEqual(
    collisions,
    [],
    `Alias collisions detected (each alias must map to exactly one provider id): ${collisions
      .map(([alias, ids]) => `"${alias}" → ${ids.join(", ")}`)
      .join("; ")}`
  );
});

test("primary providers keep the short alias", () => {
  // open-sse registry (source of the startup warning + chat routing)
  assert.equal(PROVIDER_ID_TO_ALIAS.kimi, "kimi");
});

test("src/shared providers map resolves the same aliases unambiguously", () => {
  // alias → id
  assert.equal(resolveProviderId("kimi"), "kimi");
  // id → alias
  assert.equal(getProviderAlias("kimi"), "kimi");
});

test("retired Hailuo alias is absent while official MiniMax aliases remain distinct", () => {
  assert.equal(PROVIDER_ID_TO_ALIAS["hailuo-web"], undefined);
  assert.equal(PROVIDER_ID_TO_ALIAS.minimax, "minimax");
  assert.equal(PROVIDER_ID_TO_ALIAS["minimax-cn"], "minimax-cn");
  assert.equal(resolveProviderId("minimax"), "minimax");
  assert.equal(resolveProviderId("minimax-cn"), "minimax-cn");
});
