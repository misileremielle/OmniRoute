import { afterEach, beforeEach } from "node:test";

/**
 * Code that waits only on AbortSignal.timeout or unref()'d timers leaves the event loop with
 * no ref'd handle. node:test then sees an idle loop and cancels the running test mid-await
 * ("Promise resolution is still pending but the event loop has already resolved"). Holding a
 * ref'd timer for each test's duration keeps the loop alive without changing what is measured.
 * Call once at the top level of a test file (or inside a describe block).
 */
export function keepEventLoopAliveDuringTests(): void {
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  beforeEach(() => {
    keepAlive = setInterval(() => {}, 1_000);
  });
  afterEach(() => {
    clearInterval(keepAlive);
    keepAlive = undefined;
  });
}
