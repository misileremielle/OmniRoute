import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getRegisteredCredentialRefresher,
  registerCredentialRefresher,
} from "../../open-sse/utils/registeredCredentialRefresher.ts";

const _FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const _PAST = new Date(Date.now() - 3_600_000).toISOString();

test.afterEach(() => registerCredentialRefresher(null));

test("the token-refresh module registers itself and startup loads it", async () => {
  // A fresh evaluation of the module proves the side effect, whatever loaded it first.
  await import(`../../src/sse/services/tokenRefresh.ts?registers=${Date.now()}`);
  assert.equal(typeof getRegisteredCredentialRefresher(), "function");

  const startup = fs.readFileSync("src/instrumentation-node.ts", "utf8");
  assert.match(startup, /await import\("@\/sse\/services\/tokenRefresh"\)/);
});
