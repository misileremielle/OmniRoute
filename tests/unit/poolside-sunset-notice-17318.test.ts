import test from "node:test";
import assert from "node:assert/strict";
import { APIKEY_PROVIDERS_INFERENCE } from "../../src/shared/constants/providers/apikey/inference-hosts.ts";

test("#17318 direct Poolside setup warns about the announced shutdown date", () => {
  const provider = APIKEY_PROVIDERS_INFERENCE.poolside;
  assert.match(provider.freeNote, /2026-10-31/);
  assert.match(provider.apiHint, /2026-10-31/);
  assert.match(provider.apiHint, /platform\.poolside\.ai/);
});
