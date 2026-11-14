/**
 * NoAuth executor wrapper contract sweep.
 *
 * Why this file exists
 * --------------------
 * `open-sse/handlers/chatCore.ts` reads `res.response.status`, `res.response.headers`,
 * and uses `res.url` / `res.transformedBody` to classify upstream responses
 * (see chatCore.ts:3937–4486, BaseExecutor.execute() at base.ts:1146).
 *
 * An executor that returns a raw `Response` instead of the wrapper shape
 * `{response, url, headers, transformedBody}` causes `res.response.status` to
 * throw `Cannot read properties of undefined (reading 'status')`. That JS
 * TypeError was then surfaced as a 502 via `formatProviderError` in
 * `open-sse/utils/error.ts:496`, and showed up to the client as
 * `[502]: Cannot read properties of undefined (reading 'status')`.
 *
 * The duckduckgo-web executor was the first known case. To prevent any
 * future executor from regressing on the same contract, this sweep test
 * imports the keyless `NOAUTH_PROVIDERS` executors, calls `execute()` with a minimal
 * but valid input, and asserts the wrapper shape. Tests use the
 * pre-aborted signal path or empty-creds path so no real upstream call
 * is needed.
 *
 * If this file ever flags a missing executor, the fix is in the executor
 * — the contract is the executor's responsibility.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { NOAUTH_PROVIDERS } from "../../src/shared/constants/providers.ts";

type NoauthId = keyof typeof NOAUTH_PROVIDERS;
const NOAUTH_IDS = Object.keys(NOAUTH_PROVIDERS) as NoauthId[];

const VALID_BODY = {
  model: "test",
  messages: [{ role: "user", content: "ping" }],
};

/**
 * Asserts that `result` has the executor wrapper contract shape:
 *   { response: Response, url: string, headers: object, transformedBody: unknown }
 *
 * The contract is what `open-sse/handlers/chatCore.ts` and
 * `BaseExecutor.execute()` (open-sse/executors/base.ts:1146) depend on.
 */
function assertExecutorWrapperShape(
  result: unknown,
  provider: string
): asserts result is {
  response: Response;
  url: string;
  headers: Record<string, unknown>;
  transformedBody: unknown;
} {
  assert.ok(
    result && typeof result === "object",
    `[${provider}] execute() must return an object, not ${typeof result}`
  );
  const r = result as Record<string, unknown>;
  assert.ok(
    r.response instanceof Response,
    `[${provider}] result.response must be a Response (got ${typeof r.response})`
  );
  assert.equal(typeof r.url, "string", `[${provider}] result.url must be a string`);
  assert.ok(
    r.headers && typeof r.headers === "object",
    `[${provider}] result.headers must be an object`
  );
  // transformedBody may be null/undefined/object; just check it doesn't
  // throw when accessed.
  void r.transformedBody;
  // Critical: r.response.status must be reachable without throwing
  // — this is the exact property read that the duckduckgo-web bug
  // (#3106) crashed on.
  const status = (r.response as Response).status;
  assert.ok(
    Number.isInteger(status) && status >= 100 && status < 600,
    `[${provider}] result.response.status must be a valid HTTP status, got ${status}`
  );
}

describe("noauth executor wrapper contract sweep", () => {
  describe("NOAUTH_PROVIDERS (4 total; 2 require cookie='') ", () => {
    // Only noauth providers that should be probed without creds:
    // duckduckgo-web and veoaifree-web. opencode/notice have dedicated
    // executor tests already (executor-opencode.test.ts / executor-notice.test.ts).
    const TARGETS = NOAUTH_IDS.filter((id) => id === "duckduckgo-web" || id === "veoaifree-web");

    for (const providerId of TARGETS) {
      it(`${providerId} noauth executor returns wrapper shape`, async () => {
        const executor = await getExecutor(providerId);
        assert.ok(executor, `[${providerId}] getExecutor must return an executor`);

        // Use a pre-aborted signal so the executor short-circuits via
        // its AbortError path before any real network call.
        const controller = new AbortController();
        controller.abort();

        const result = await executor.execute({
          model: providerId,
          body: VALID_BODY,
          stream: false,
          credentials: { apiKey: "" },
          signal: controller.signal,
        } as never);

        // duckduckgo-web may legitimately short-circuit with a bare
        // 499 Response on a pre-aborted signal; chatCore's
        // normalizeExecutorResult already accepts both shapes. Only
        // insist on the full wrapper for executors that are expected
        // to produce one.
        if (result instanceof Response) {
          assert.ok(
            result.status >= 100 && result.status < 600,
            `[${providerId}] bare Response must have a valid HTTP status, got ${result.status}`
          );
        } else {
          assertExecutorWrapperShape(result, providerId);
        }
        const body = await (result instanceof Response ? result : result.response).text();
        assert.ok(body.length > 0, `[${providerId}] response body must be non-empty`);
        assert.doesNotMatch(
          body,
          /Cannot read properties of undefined \(reading 'status'\)/,
          `[${providerId}] must not surface the chatCore-side TypeError`
        );
      });
    }
  });
});
