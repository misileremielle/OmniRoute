import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CODEX_CLIENT_VERSION } from "../../src/shared/constants/codexClient.ts";
import {
  clearCodexClientVersionCache,
  getCodexClientVersion,
  resolveCodexClientVersion,
} from "../../open-sse/config/codexClient.ts";

const CODEX_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";

function releaseFetch(tagName: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    assert.equal(String(url), CODEX_RELEASE_URL);
    return new Response(JSON.stringify({ tag_name: tagName }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test.afterEach(() => {
  clearCodexClientVersionCache();
  delete process.env.CODEX_CLIENT_VERSION;
});

// Derived from the pin: the release has to be *newer* than it to be accepted, so
// a hard-coded tag silently turns into a downgrade on the next bump.
const NEWER = (() => {
  const [major, minor, patch] = DEFAULT_CODEX_CLIENT_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();

test("a fetched Codex release newer than the pin is returned", async () => {
  await withEnv({ CODEX_CLIENT_VERSION: undefined }, async () => {
    const version = await resolveCodexClientVersion(releaseFetch(`rust-v${NEWER}`));
    assert.equal(version, NEWER);
    assert.equal(getCodexClientVersion(), NEWER);
    assert.notEqual(version, DEFAULT_CODEX_CLIENT_VERSION);
  });
});

test("a rejected fetch falls back to the pinned Codex version", async () => {
  await withEnv({ CODEX_CLIENT_VERSION: undefined }, async () => {
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const version = await resolveCodexClientVersion(failingFetch);
    assert.equal(version, DEFAULT_CODEX_CLIENT_VERSION);
    assert.equal(getCodexClientVersion(), DEFAULT_CODEX_CLIENT_VERSION);
  });
});

test("CODEX_CLIENT_VERSION beats a newer fetched release", async () => {
  await withEnv({ CODEX_CLIENT_VERSION: "0.99.0" }, async () => {
    const version = await resolveCodexClientVersion(releaseFetch(`rust-v${NEWER}`));
    assert.equal(version, NEWER);
    assert.equal(getCodexClientVersion(), "0.99.0");
  });
});
