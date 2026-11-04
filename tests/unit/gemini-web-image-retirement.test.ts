import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
const geminiWebExecutorModule = await import("../../open-sse/executors/gemini-web.ts");
const { GeminiWebExecutor } = geminiWebExecutorModule;
const { getExecutor: _getExecutor, hasSpecializedExecutor: _hasSpecializedExecutor } =
  await import("../../open-sse/executors/index.ts");
const { REGISTRY: _REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");

test("Gemini Web executor treats the retired image-mode extension as ordinary chat input", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const waitDurations: number[] = [];

  const candidate: unknown[] = [];
  candidate[1] = ["standard chat reply"];
  const extensions: unknown[] = [];
  extensions[7] = [[[[null, null, null, "https://lh3.googleusercontent.com/retired-image"]]]];
  candidate[12] = extensions;
  const payload = JSON.stringify([null, [], null, null, [candidate]]);
  const raw = `)]}'\n42\n${JSON.stringify([["wrb.fr", null, payload]])}\n`;

  playwright.chromium.launch = (async () =>
    ({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => ({
          on: (
            event: string,
            handler: (response: { url: () => string; text: () => Promise<string> }) => void
          ) => {
            if (event === "response") {
              void handler({
                url: () => "https://gemini.google.com/_/StreamGenerate",
                text: async () => raw,
              });
            }
          },
          goto: async () => {},
          waitForTimeout: async (duration: number) => {
            waitDurations.push(duration);
          },
          waitForSelector: async () => ({ click: async () => {} }),
          keyboard: { type: async () => {}, insertText: async () => {}, press: async () => {} },
        }),
      }),
      close: async () => {},
    }) as unknown as Awaited<ReturnType<typeof originalLaunch>>) as typeof originalLaunch;

  try {
    const result = await new GeminiWebExecutor().execute({
      model: "gemini-3.1-pro",
      body: {
        messages: [{ role: "user", content: "hello" }],
        x_gemini_web_image_mode: true,
      },
      stream: false,
      credentials: { apiKey: "fake-cookie=abc" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as Record<string, unknown>;
    assert.equal(json.x_gemini_web_image_urls, undefined);
    assert.equal(
      (json.choices as Array<{ message: { content: string } }>)[0].message.content,
      "standard chat reply"
    );
    assert.equal(waitDurations.includes(90_000), false);
    assert.equal(waitDurations.includes(30_000), true);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});

test("Gemini Web image-only parser and handler artifacts are retired", () => {
  assert.equal("parseStreamResponseImages" in geminiWebExecutorModule, false);
  assert.equal(
    existsSync(
      new URL("../../open-sse/handlers/imageGeneration/providers/geminiWeb.ts", import.meta.url)
    ),
    false
  );
});
