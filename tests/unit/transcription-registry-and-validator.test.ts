import assert from "node:assert/strict";
import test from "node:test";

const registry = await import("../../open-sse/config/transcriptionRegistry.ts");
const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Model resolution (same rules as chat: prefix wins, bare id only when unambiguous) ──

test("prefixed and unambiguous bare ids resolve; case is ignored", () => {
  for (const [input, provider, model] of [
    ["azure-speech/mai-transcribe-2", "azure-speech", "mai-transcribe-2"],
    // Model ids ignore case (Azure spells them MAI-Transcribe-2); the provider prefix does not.
    ["azure-speech/MAI-Transcribe-2", "azure-speech", "mai-transcribe-2"],
    ["mai-transcribe-1.5", "azure-speech", "mai-transcribe-1.5"],
    ["openrouter/microsoft/mai-transcribe-2", "openrouter", "microsoft/mai-transcribe-2"],
    ["microsoft/mai-transcribe-2", "openrouter", "microsoft/mai-transcribe-2"],
  ]) {
    const resolved = registry.resolveTranscriptionModel(input);
    assert.ok(resolved.ok, input);
    if (!resolved.ok) continue;
    assert.equal(resolved.provider.id, provider, input);
    assert.equal(resolved.model.id, model, input);
  }
});

test("unknown, empty and unsafe model strings are 400s with chat-style messages", () => {
  const cases: [unknown, RegExp][] = [
    ["", /model is required/],
    [undefined, /model is required/],
    ["whisper-1", /'whisper-1' could not be resolved to a known transcription provider/],
    ["azure-speech/whisper-1", /not a transcription model of provider 'azure-speech'/],
    ["../etc/passwd", /Invalid model format|could not be resolved/],
  ];
  for (const [input, pattern] of cases) {
    const resolved = registry.resolveTranscriptionModel(input);
    assert.equal(resolved.ok, false, String(input));
    if (resolved.ok) continue;
    assert.equal(resolved.status, 400);
    assert.match(resolved.message, pattern);
  }
});

test("every model is listed once as provider/model", () => {
  const ids = registry.getAllTranscriptionModels().map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("azure-speech/mai-transcribe-2"));
  assert.ok(ids.includes("openrouter/microsoft/mai-transcribe-2"));
});

test("Azure URLs keep only an https origin from the connection's endpoint", () => {
  assert.equal(
    registry.resolveAzureSpeechTranscribeUrl(
      "https://eastus.api.cognitive.microsoft.com/some/path?x=1"
    ),
    "https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
  );
  assert.equal(
    registry.resolveAzureSpeechValidationUrl("https://my-speech.cognitiveservices.azure.com/"),
    "https://my-speech.cognitiveservices.azure.com/speechtotext/models/base?top=1&api-version=2025-10-15"
  );
  // Proxy's decision: URL only. A bare region, plain http and embedded credentials are refused.
  for (const bad of [
    "eastus",
    "http://eastus.api.cognitive.microsoft.com",
    "https://u:p@x.com",
    "",
    7,
  ]) {
    assert.equal(registry.resolveAzureSpeechTranscribeUrl(bad), null, String(bad));
  }
});

// ── Connection validation (Models - List Base Models) ──

const ENDPOINT = "https://eastus.api.cognitive.microsoft.com";

async function validate(answer: () => Response, baseUrl: string | null = ENDPOINT) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    return answer();
  }) as typeof fetch;
  const result = await validateProviderApiKey({
    provider: "azure-speech",
    apiKey: "speech-key",
    providerSpecificData: baseUrl === null ? {} : { baseUrl },
  });
  return { result, calls };
}

test("a Speech resource answering its base-model list validates the key", async () => {
  const { result, calls } = await validate(() => Response.json({ values: [] }));
  assert.equal(result.valid, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/speechtotext/models/base?top=1&api-version=2025-10-15`);
  assert.equal(calls[0].headers["Ocp-Apim-Subscription-Key"], "speech-key");
});

test("a 200 that is not the Speech API's body does not validate", async () => {
  const { result } = await validate(() => new Response("<html>ok</html>", { status: 200 }));
  assert.equal(result.valid, false);
  assert.match(String(result.error), /did not answer like an Azure Speech resource/);
});

test("failure statuses map to specific messages", async () => {
  for (const [status, pattern] of [
    [401, /Invalid API key/],
    [403, /Invalid API key/],
    [404, /not an Azure Speech resource/],
    [429, /Rate limited/],
  ] as const) {
    const { result } = await validate(() => new Response("", { status }));
    assert.equal(result.valid, false, String(status));
    assert.match(String(result.error), pattern, String(status));
  }
});

test("a missing or bare-region endpoint fails without a request", async () => {
  for (const baseUrl of [null, "", "eastus"]) {
    const { result, calls } = await validate(() => Response.json({ values: [] }), baseUrl);
    assert.equal(result.valid, false);
    assert.match(String(result.error), /https resource endpoint/);
    assert.equal(calls.length, 0);
  }
});
