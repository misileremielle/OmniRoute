/**
 * Regression test for issue #13881: a revoked, expired, or banned API key
 * must NOT resolve an `apiKeyId` in `getApiKeyRequestScope()` — it must fail
 * closed to the same `{ apiKeyId: null }` shape as an unresolved/anonymous
 * caller.
 *
 * (The Batch API routes this originally covered were removed; the lifecycle
 * gate itself is kept and covered here at the helper level.)
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir BEFORE any `@/lib/db/*`
 * module loads, so this file never touches ~/.omniroute.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apikey-scope-13881-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "apikey-scope-13881-secret";

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createApiKey, revokeApiKey, validateApiKey, setApiKeyExpiry, updateApiKeyPermissions } =
  await import("../../src/lib/db/apiKeys.ts");
const { getApiKeyRequestScope } = await import("../../src/app/api/v1/_helpers/apiKeyScope.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function requestWith(rawKey: string) {
  return new Request("http://localhost/api/v1/models", {
    headers: { Authorization: `Bearer ${rawKey}` },
  });
}

describe("issue #13881 — revoked/expired/banned API key must fail closed in getApiKeyRequestScope", () => {
  it("getApiKeyRequestScope returns apiKeyId: null for a REVOKED key", async () => {
    const created = await createApiKey("revoke-me", "machine-13881-a", []);
    const rawKey = created.key;
    const keyId = created.id;

    const revoked = await revokeApiKey(keyId);
    assert.equal(revoked, true, "revokeApiKey should succeed");

    const stillValid = await validateApiKey(rawKey);
    assert.equal(stillValid, false, "validateApiKey correctly rejects the revoked key");

    const scope = await getApiKeyRequestScope(requestWith(rawKey));
    assert.equal(scope.apiKeyId, null, "revoked key must resolve to apiKeyId: null");
    assert.equal(scope.apiKeyMetadata, null, "revoked key must resolve to apiKeyMetadata: null");
  });

  it("an EXPIRED key resolves to apiKeyId: null with keyState invalid", async () => {
    const created = await createApiKey("expired-me", "machine-13881-d", []);
    const rawKey = created.key;
    const keyId = created.id;

    await setApiKeyExpiry(keyId, new Date(Date.now() - 60_000).toISOString());
    assert.equal(await validateApiKey(rawKey), false, "expired key must fail validateApiKey");

    const scope = await getApiKeyRequestScope(requestWith(rawKey));
    assert.equal(scope.apiKeyId, null, "expired key must resolve to apiKeyId: null");
    assert.equal(scope.keyState, "invalid", "expired key must resolve to keyState: invalid");
  });

  it("a BANNED key resolves to apiKeyId: null with keyState invalid", async () => {
    const created = await createApiKey("banned-me", "machine-13881-e", []);
    const rawKey = created.key;
    const keyId = created.id;

    await updateApiKeyPermissions(keyId, { isBanned: true });
    assert.equal(await validateApiKey(rawKey), false, "banned key must fail validateApiKey");

    const scope = await getApiKeyRequestScope(requestWith(rawKey));
    assert.equal(scope.apiKeyId, null, "banned key must resolve to apiKeyId: null");
    assert.equal(scope.keyState, "invalid", "banned key must resolve to keyState: invalid");
  });

  it("an ACTIVE key is still resolved normally (regression guard against over-blocking)", async () => {
    const created = await createApiKey("still-active", "machine-13881-f", []);
    const rawKey = created.key;
    const keyId = created.id;

    assert.equal(await validateApiKey(rawKey), true, "freshly created key must be valid");

    const scope = await getApiKeyRequestScope(requestWith(rawKey));
    assert.equal(scope.apiKeyId, keyId, "active key must still resolve its apiKeyId");
    assert.equal(scope.keyState, "valid", "active key must resolve to keyState: valid");
    assert.notEqual(scope.apiKeyMetadata, null, "active key must still resolve its metadata");
  });
});
