import test from "node:test";
import assert from "node:assert/strict";
import * as embeddingRegistry from "../../open-sse/config/embeddingRegistry.ts";
import * as rerankRegistry from "../../open-sse/config/rerankRegistry.ts";
import * as searchRegistry from "../../open-sse/config/searchRegistry.ts";

const registries = [
  { name: "embedding", mod: embeddingRegistry, keys: ["EMBEDDING_PROVIDERS"] },
  { name: "rerank", mod: rerankRegistry, keys: ["RERANK_PROVIDERS"] },
  { name: "search", mod: searchRegistry, keys: ["SEARCH_PROVIDERS"] },
];

for (const { name, mod, keys } of registries) {
  for (const key of keys) {
    test(`${name} registry: ${key} is a plain object, not a Proxy`, () => {
      const registry = mod[key];
      assert.ok(registry, `${key} should be exported`);
      assert.equal(typeof registry, "object");

      // Proxy traps break Object.keys() — plain objects return keys immediately
      const firstKey = Object.keys(registry)[0];
      assert.ok(firstKey, `${key} should have at least one entry`);

      // Direct property access should work without trap overhead
      const entry = registry[firstKey];
      assert.ok(entry, `First entry should be accessible`);
    });

    test(`${name} registry: ${key} entries are mutable (no Proxy freeze)`, () => {
      const registry = mod[key];
      const firstKey = Object.keys(registry)[0];
      const original = registry[firstKey];

      // Should be able to mutate without Proxy restrictions
      registry[firstKey] = { ...original, _test: true };
      assert.ok(registry[firstKey]._test === true);

      // Restore
      registry[firstKey] = original;
    });
  }
}
