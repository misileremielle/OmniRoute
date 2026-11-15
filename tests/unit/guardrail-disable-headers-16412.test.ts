import test from "node:test";
import assert from "node:assert/strict";
import { resolveDisabledGuardrails } from "../../src/lib/guardrails/registry.ts";

test("both disable headers join key, body and metadata channels without duplicates", () => {
  for (const headers of [
    new Headers({
      "x-omniroute-disabled-guardrails": "vision-bridge,Credential_Masker",
      "x-disabled-guardrails": "other-guardrail,credential-masker",
    }),
    {
      "X-OmniRoute-Disabled-Guardrails": "vision-bridge,Credential_Masker",
      "X-Disabled-Guardrails": "other-guardrail,credential-masker",
    },
  ]) {
    assert.deepEqual(
      resolveDisabledGuardrails({
        apiKeyInfo: { disabledGuardrails: ["credential-masker"] },
        body: {
          disabledGuardrails: ["custom-guardrail"],
          metadata: { disabledGuardrails: ["credential-masker"] },
        },
        headers,
      }),
      ["credential-masker", "custom-guardrail", "vision-bridge", "other-guardrail"]
    );
  }
});
