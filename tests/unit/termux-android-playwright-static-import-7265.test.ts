import { test } from "node:test";

// Regression guard for #7265: on Termux/Android, `process.platform === "android"`.
// `playwright-core`'s serverRegistry.js throws `Unsupported platform: android` from a
// top-level IIFE at *require time* — merely importing the `playwright` package crashes,
// no browser needs to be launched, so the executor registry must never import it
// statically.

test("importing the real executor chain does not throw on an unsupported process.platform", async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "android", configurable: true });

  try {
    // Keep the executor-registry import safe for direct runtime consumers. Before the
    // original fix, this threw "Unsupported platform: android" purely from the static
    // playwright import; instrumentation no longer imports this graph at boot (#12074).
    await import("../../open-sse/executors/index.ts");
  } finally {
    Object.defineProperty(process, "platform", originalDescriptor);
  }
});
