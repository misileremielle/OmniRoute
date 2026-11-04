import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-leaderboard-stream-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.INITIAL_PASSWORD;

const core = await import("../../../src/lib/db/core.ts");
const { NextRequest } = await import("next/server");
const route = await import("../../../src/app/api/gamification/stream/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 2000) {
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("stream did not close")), ms);
      timer.unref();
    }),
  ]);
}

// A client that disconnects before the stream starts (e.g. while auth is pending)
// arrives with an already-aborted signal; "abort" never fires again. The route used to
// arm a 5s leaderboard query and 15s heartbeat anyway, running for the life of the
// process. It must close immediately instead.
test("leaderboard stream closes at once for an already-aborted client", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new NextRequest("http://localhost/api/gamification/stream", {
    signal: controller.signal,
  });
  const response = await route.GET(request);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const chunk = await readWithTimeout(reader);
  assert.equal(chunk.done, true);
});

test("cancelling the leaderboard stream tears down its timers", async () => {
  const controller = new AbortController();
  const request = new NextRequest("http://localhost/api/gamification/stream", {
    signal: controller.signal,
  });
  const response = await route.GET(request);
  const reader = response.body!.getReader();
  await reader.cancel();
  // With the intervals still armed the test runner would hang here instead of exiting.
});
