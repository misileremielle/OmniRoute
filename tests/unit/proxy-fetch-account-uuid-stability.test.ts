/**
 * The synthesized account_uuid must not churn.
 *
 * `resolveAccountUUID` used the access token as its seed. Claude OAuth access
 * tokens rotate on refresh, so the fallback UUID changed roughly hourly for a
 * single account — the account looked like a new one every refresh, which is
 * exactly what an account identifier exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAccountUUID } from "../../open-sse/executors/claudeIdentity.ts";

const CLI_ID = "a".repeat(64);
const psd = { cliUserID: CLI_ID };

test("the fallback identifier survives an access-token rotation", () => {
  const first = resolveAccountUUID(psd, "sk-ant-oat01-first");
  const second = resolveAccountUUID(psd, "sk-ant-oat01-second");
  assert.equal(second, first);
});

test("the fallback identifier is still per account", () => {
  const a = resolveAccountUUID({ cliUserID: "a".repeat(64) }, "sk-ant-oat01-token");
  const b = resolveAccountUUID({ cliUserID: "b".repeat(64) }, "sk-ant-oat01-token");
  assert.notEqual(a, b);
});

test("the fallback is a v4-shaped uuid", () => {
  const uuid = resolveAccountUUID(psd, "sk-ant-oat01-token");
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a real uuid from provisioning still wins over the fallback", () => {
  const real = "11111111-2222-4333-8444-555555555555";
  assert.equal(resolveAccountUUID({ ...psd, accountUUID: real }, "sk-ant-oat01-token"), real);
  assert.equal(resolveAccountUUID({ ...psd, account_uuid: real }, "sk-ant-oat01-token"), real);
});
