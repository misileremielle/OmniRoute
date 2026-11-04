// Cheaper Inference image models + the Adobe Firefly collision guard.
//
// nano-banana-pro / nano-banana-2 exist in BOTH providers. parseImageModel resolves a
// bare id by first-match over IMAGE_PROVIDERS iteration order, so the bare ids must
// keep going to adobe-firefly (pre-existing behaviour) and Cheaper Inference must be
// reachable only via its prefix. Operator decision 2026-07-31.
import { test } from "node:test";
import assert from "node:assert/strict";

test("cheaperinference image models are NOT in the chat registry", async () => {
  const { REGISTRY } = await import("@omniroute/open-sse/config/providers/index.ts");
  const chatIds = new Set(
    (REGISTRY.cheaperinference as unknown as { models: Array<{ id: string }> }).models.map(
      (m) => m.id
    )
  );
  // Upstream returns HTTP 400 for these on /v1/chat/completions:
  // "…is an image-generation model. Use POST /v1/images/generations."
  for (const id of ["grok-imagine", "nano-banana-2", "nano-banana-pro"]) {
    assert.ok(!chatIds.has(id), `${id} must not be routable as a chat model`);
  }
});
