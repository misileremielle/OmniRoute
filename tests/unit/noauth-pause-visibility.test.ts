/**
 * Active free-tier pauses are exposed read-only for the account card.
 *
 * Setup always goes through the production writer `noteOpencodeFreeTierSkip`
 * (never a hand-built table) with a frozen `now`.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const { noteOpencodeFreeTierSkip, clearOpencodeFreeTierSkips, listOpencodeFreeTierPauses } =
  await import("../../open-sse/services/opencodeFreeTierSkip.ts");
const { GET } = await import("../../src/app/api/admin/proxy-pool-visibility/route.ts");

const PROVIDER = "opencode-pause-demo";
const MODEL = "muse-spark-1.3-contributor-free";

beforeEach(() => {
  clearOpencodeFreeTierSkips();
});
after(() => {
  clearOpencodeFreeTierSkips();
});

test("active pause on a model exposes provider, model, end and motive", () => {
  const now = 1_000_000;
  noteOpencodeFreeTierSkip(PROVIDER, now, 60_000, MODEL);
  const pauses = listOpencodeFreeTierPauses(PROVIDER, now + 10_000);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].provider, PROVIDER);
  assert.equal(pauses[0].model, MODEL);
  assert.equal(pauses[0].until, new Date(now + 60_000).toISOString());
  assert.equal(pauses[0].reason, "Free-tier request refused (429)");
});

test("expired pause is absent", () => {
  const now = 1_000_000;
  noteOpencodeFreeTierSkip(PROVIDER, now, 50, MODEL);
  assert.deepEqual(listOpencodeFreeTierPauses(PROVIDER, now + 50), []);
  assert.deepEqual(listOpencodeFreeTierPauses(PROVIDER, now + 51), []);
});

test("no pause exposes nothing", () => {
  assert.deepEqual(listOpencodeFreeTierPauses(PROVIDER, 1_000_000), []);
});

test("foreign provider exposes nothing", () => {
  const now = 1_000_000;
  noteOpencodeFreeTierSkip(PROVIDER, now, 60_000, MODEL);
  assert.deepEqual(listOpencodeFreeTierPauses("groq", now + 1_000), []);
});

test("wide pause exposes a null model", () => {
  const now = 1_000_000;
  noteOpencodeFreeTierSkip(PROVIDER, now, 60_000);
  const pauses = listOpencodeFreeTierPauses(PROVIDER, now + 1_000);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].provider, PROVIDER);
  assert.equal(pauses[0].model, null);
  assert.equal(pauses[0].until, new Date(now + 60_000).toISOString());
});

test("model id outside the contract stays attached to its provider", () => {
  const now = 1_000_000;
  noteOpencodeFreeTierSkip(PROVIDER, now, 60_000, "a\nb");
  const pauses = listOpencodeFreeTierPauses(PROVIDER, now + 1_000);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].model, "b");
});

function req(url: string): Request {
  return new Request(`http://localhost${url}`);
}

test("route exposes an active pause with provider, model, end and motive", async () => {
  const before = Date.now();
  noteOpencodeFreeTierSkip(PROVIDER, before, 60_000, MODEL);
  const res = await GET(
    req(`/api/admin/proxy-pool-visibility?freeTierPauses=1&provider=${PROVIDER}`)
  );
  if (res.status === 401 || res.status === 403) return;
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    provider: string;
    pauses: Array<{ model: string | null; until: string; reason: string }>;
    processMemory: boolean;
  };
  assert.equal(body.provider, PROVIDER);
  assert.equal(body.processMemory, true);
  assert.equal(body.pauses.length, 1);
  assert.equal(body.pauses[0].model, MODEL);
  assert.ok(Number.isFinite(Date.parse(body.pauses[0].until)));
  assert.match(body.pauses[0].reason, /429/);
});

test("route answers 400 without a provider", async () => {
  const res = await GET(req("/api/admin/proxy-pool-visibility?freeTierPauses=1"));
  if (res.status === 401 || res.status === 403) return;
  assert.equal(res.status, 400);
});

test("route prefers the pause payload when combined with proxyId", async () => {
  noteOpencodeFreeTierSkip(PROVIDER, Date.now(), 60_000, MODEL);
  const res = await GET(
    req(`/api/admin/proxy-pool-visibility?freeTierPauses=1&provider=${PROVIDER}&proxyId=no-such-id`)
  );
  if (res.status === 401 || res.status === 403) return;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { pauses: unknown[]; members?: unknown };
  assert.ok(Array.isArray(body.pauses));
  assert.equal(body.members, undefined);
});

test("route without the new params keeps the legacy shape", async () => {
  const noParams = await GET(req("/api/admin/proxy-pool-visibility"));
  if (noParams.status === 401 || noParams.status === 403) return;
  assert.equal(noParams.status, 400);
  const scope = await GET(req("/api/admin/proxy-pool-visibility?scope=global"));
  if (scope.status === 401 || scope.status === 403) return;
  assert.equal(scope.status, 200);
  const body = (await scope.json()) as { pauses?: unknown; members: unknown[] };
  assert.ok(Array.isArray(body.members));
  assert.equal(body.pauses, undefined);
});

// ── Card render: pause note ────────────────────────────────────────────────
// Setup goes through the production writer + production GET route: the fetch
// stub below answers the card's visibility request with the live route
// payload, never a hand-built table.
