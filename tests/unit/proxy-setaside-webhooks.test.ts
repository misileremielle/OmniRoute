import test from "node:test";
import assert from "node:assert/strict";

const memory = await import("../../open-sse/utils/proxyRefusalMemory.ts");
const listeners = await import("../../open-sse/utils/proxyTransitionListeners.ts");
const bridge = await import("../../src/lib/proxyEvents/proxyTransitionBridge.ts");
const bus = await import("../../src/lib/events/eventBus.ts");
const _types = await import("../../src/lib/events/types.ts");

const KEY = "http://user@host.example:8080";

function resetAll(): void {
  memory.__resetProxyRefusalMemoryForTesting();
  listeners.__resetProxyTransitionListenersForTesting();
  bridge.__resetBridgeForTesting();
}

test.beforeEach(() => {
  resetAll();
});

test.afterEach(() => {
  resetAll();
  delete process.env.PROXY_WEBHOOK_REBOUND_MS;
});

test("transition: first set-aside notifies once with key/kind/period/until, repeat returns null silently", () => {
  try {
    const seen: Array<{ key: string; kind: string; periodMs: number; until: number }> = [];
    listeners.onProxyTransition((t) => {
      seen.push(t);
    });
    const periodMs = memory.noteProxyRefusal(KEY, "ip_quota_429", 1_000_000);
    assert.ok(typeof periodMs === "number");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, KEY);
    assert.equal(seen[0].kind, "ip_quota_429");
    assert.equal(seen[0].periodMs, periodMs);
    assert.equal(seen[0].until, 1_000_000 + (periodMs as number));
    assert.ok(!("streak" in seen[0]), "transition carries no streak (D-OA)");
    const again = memory.noteProxyRefusal(KEY, "ip_quota_429", 1_000_001);
    assert.equal(again, null);
    assert.equal(seen.length, 1);
  } finally {
    resetAll();
  }
});

test("anti-rebound: burst of transitions on one key emits a single bus event", () => {
  try {
    bridge.registerProxyTransitionBridge();
    const received: unknown[] = [];
    const off = bus.on("proxy.set_aside", (payload) => {
      received.push(payload);
    });
    try {
      const now = 2_000_000;
      bridge.__setBridgeNowForTesting(() => now);
      for (let i = 0; i < 5; i++) {
        bridge.emitSetAside({
          key: KEY,
          kind: "ip_quota_429",
          periodMs: 60_000,
          until: now + 60_000,
        });
      }
      assert.equal(received.length, 1);
      const payload = received[0] as Record<string, unknown>;
      assert.ok(!("streak" in payload), "payload carries no streak (D-OA)");
    } finally {
      off();
    }
  } finally {
    resetAll();
  }
});

test("masking: scheme and port stay clear, user and host masked, null key silent", () => {
  try {
    assert.equal(
      bridge.maskEgressKey("https://user@host.example:8080"),
      "https://u***@ho***le:8080"
    );
    assert.equal(bridge.maskEgressKey("http://host.example:8080"), "http://ho***le:8080");
    const masked = bridge.maskEgressKey(KEY);
    assert.ok(!masked.includes("user@host.example"), "no full credentials in masked key");
    const periodMs = memory.noteProxyRefusal(null, "ip_quota_429", 3_000_000);
    assert.equal(periodMs, null);
  } finally {
    resetAll();
  }
});

test("exhausted foundation: full set-aside emits, partial does not, scope window holds", () => {
  try {
    const at = 4_000_000;
    assert.equal(bridge.shouldEmitPoolExhausted("global", 3, 3, at), true);
    assert.equal(bridge.shouldEmitPoolExhausted("global", 3, 3, at + 1_000), false);
    assert.equal(bridge.shouldEmitPoolExhausted("global", 3, 2, at + 400_000), false);
    const event = bridge.buildPoolExhaustedEvent("global", 3, 3, at);
    assert.equal(event.fallback, "fail-closed-serve");
    assert.equal(event.timestamp, at);
  } finally {
    resetAll();
  }
});

test("functional: real set-aside through outcome path emits bus event", async () => {
  const prevSkip = process.env.PROXY_SKIP_RECENTLY_FAILED;
  process.env.PROXY_SKIP_RECENTLY_FAILED = "true";
  try {
    const { noteProxyOutcome } = await import("../../src/sse/handlers/proxyOutcomeMemory.ts");
    const outcomes: unknown[] = [];
    const off = bus.on("proxy.set_aside", (payload) => {
      outcomes.push(payload);
    });
    try {
      bridge.registerProxyTransitionBridge();
      noteProxyOutcome("opencode-go", {
        proxy: "http://user:pw@host.example:8080",
        upstreamStatus: 429,
      });
      assert.equal(outcomes.length, 1);
      const payload = outcomes[0] as Record<string, unknown>;
      assert.equal(payload.reason, "ip_quota_429");
      assert.ok(!("streak" in payload), "payload carries no streak (D-OA)");
    } finally {
      off();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.PROXY_SKIP_RECENTLY_FAILED;
    else process.env.PROXY_SKIP_RECENTLY_FAILED = prevSkip;
    resetAll();
  }
});

test("pool-exhausted: two set-aside members emit one event, then silence in the window", () => {
  const prevSkip = process.env.PROXY_SKIP_RECENTLY_FAILED;
  process.env.PROXY_SKIP_RECENTLY_FAILED = "true";
  try {
    const received: unknown[] = [];
    const off = bus.on("proxy.pool.exhausted", (payload) => {
      received.push(payload);
    });
    try {
      const at = 6_000_000;
      const keyOf = (row: unknown) => (row as { key: string }).key;
      const avoided = (key: string | null) => key === "k1" || key === "k2";
      assert.equal(
        bridge.maybeEmitPoolExhausted("global", [{ key: "k1" }, { key: "k2" }], keyOf, avoided, at),
        true
      );
      assert.equal(received.length, 1);
      assert.equal(
        bridge.maybeEmitPoolExhausted(
          "global",
          [{ key: "k1" }, { key: "k2" }],
          keyOf,
          avoided,
          at + 1_000
        ),
        false
      );
      assert.equal(received.length, 1);
    } finally {
      off();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.PROXY_SKIP_RECENTLY_FAILED;
    else process.env.PROXY_SKIP_RECENTLY_FAILED = prevSkip;
    resetAll();
  }
});

test("pool-exhausted: one member still eligible emits nothing", () => {
  const prevSkip = process.env.PROXY_SKIP_RECENTLY_FAILED;
  process.env.PROXY_SKIP_RECENTLY_FAILED = "true";
  try {
    const received: unknown[] = [];
    const off = bus.on("proxy.pool.exhausted", (payload) => {
      received.push(payload);
    });
    try {
      const keyOf = (row: unknown) => (row as { key: string }).key;
      const avoided = (key: string | null) => key === "k1";
      assert.equal(
        bridge.maybeEmitPoolExhausted("global", [{ key: "k1" }, { key: "k2" }], keyOf, avoided),
        false
      );
      assert.equal(received.length, 0);
    } finally {
      off();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.PROXY_SKIP_RECENTLY_FAILED;
    else process.env.PROXY_SKIP_RECENTLY_FAILED = prevSkip;
    resetAll();
  }
});

test("pool-exhausted: flag off emits nothing even when all are set aside", () => {
  process.env.PROXY_SKIP_RECENTLY_FAILED = "false";
  try {
    const received: unknown[] = [];
    const off = bus.on("proxy.pool.exhausted", (payload) => {
      received.push(payload);
    });
    try {
      const keyOf = (row: unknown) => (row as { key: string }).key;
      const avoided = (_key: string | null) => true;
      assert.equal(
        bridge.maybeEmitPoolExhausted("global", [{ key: "k1" }, { key: "k2" }], keyOf, avoided),
        false
      );
      assert.equal(received.length, 0);
    } finally {
      off();
    }
  } finally {
    resetAll();
  }
});
