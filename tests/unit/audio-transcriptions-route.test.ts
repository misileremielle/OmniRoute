import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stt-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "stt-route-test-secret";

const route = await import("../../src/app/api/v1/audio/transcriptions/route.ts");
const { MAX_BODY_BYTES_TRANSCRIPTION } =
  await import("../../src/shared/middleware/bodySizeGuard.ts");
const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");
rateLimiter.setRateLimiterTestMode(true);

const OGG = new Uint8Array(
  fs.readFileSync(new URL("../fixtures/audio/sine-440hz-3s-opus.ogg", import.meta.url))
);

test.after(() => {
  route.__setUploadTimeoutsForTest();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function apiKey(permissions: Record<string, unknown> = {}) {
  const created = await apiKeysDb.createApiKey("STT route key", "stt-route-machine");
  if (Object.keys(permissions).length) {
    await apiKeysDb.updateApiKeyPermissions(created.id, permissions);
  }
  return created.key as string;
}

const STREAMED_MODEL = "openrouter/openai/whisper-1";
const PAST_MODEL_POLICY = "No credentials for provider: openrouter";

/**
 * A streamed multipart request that records whether its body was ever pulled. With
 * `stall`, the body sends its first bytes and then never sends more.
 */
function streamedPost(options: { key?: string; stall?: boolean } = {}) {
  const state = { pulled: false };
  const boundary = "stt-boundary";
  // A complete upload (model + WAV file) that passes every check up to credential selection;
  // no OpenRouter connection exists here, so it ends at "No credentials for provider".
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${STREAMED_MODEL}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\nRIFF\0\0\0\0WAVEfmt \r\n--${boundary}--\r\n`
  );
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled = true;
        if (options.stall) {
          if (!sent) controller.enqueue(head.slice(0, 10));
          sent = true;
          return new Promise(() => {});
        }
        controller.enqueue(head);
        controller.close();
      },
      // highWaterMark 0: pull runs only when someone reads, not once when the stream is built.
    },
    { highWaterMark: 0 }
  );
  const request = new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    body,
    duplex: "half",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
    },
  } as RequestInit & { duplex: "half" });
  return { request, state };
}

/** What Nomily's Custom ASR sends (CustomASR.swift / AsrClients.kt), plus any extra fields. */
function nomilyForm(fields: Record<string, string | string[]> = {}, withFile = true) {
  const form = new FormData();
  if (withFile) {
    form.append("file", new File([new Uint8Array([1, 2, 3])], "audio.ogg", { type: "audio/ogg" }));
  }
  const all = { model: "whisper-1", response_format: "verbose_json", ...fields };
  for (const [name, value] of Object.entries(all)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
  }
  return form;
}

function post(body: FormData | string, headers: Record<string, string> = {}) {
  return route.POST(
    new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body, headers })
  );
}

async function errorMessage(response: Response): Promise<string> {
  return String(((await response.json()) as { error?: { message?: string } }).error?.message);
}

test("Nomily's default model whisper-1 is a 400 naming the models that work", async () => {
  const response = await post(nomilyForm());
  assert.equal(response.status, 400);
  const message = await errorMessage(response);
  assert.match(message, /'whisper-1' could not be resolved to a known transcription provider/);
  assert.match(message, /azure-speech\/mai-transcribe-2/);
  assert.doesNotMatch(message, /at \//, "no stack trace");
});

test("a valid model without a connection is a 400 naming the provider", async () => {
  const response = await post(nomilyForm({ model: "mai-transcribe-2" }));
  assert.equal(response.status, 400);
  assert.equal(await errorMessage(response), "No credentials for provider: azure-speech");
});

test("a JSON body is refused: the endpoint is multipart like OpenAI's", async () => {
  const response = await post(JSON.stringify({ model: "x" }), {
    "content-type": "application/json",
  });
  assert.equal(response.status, 400);
  assert.match(await errorMessage(response), /multipart\/form-data/);
});

test("form problems are 400s", async () => {
  const cases: [FormData, RegExp][] = [
    [nomilyForm({}, false), /file is required/],
    [nomilyForm({ model: ["a", "b"] }), /sent more than once/],
    [nomilyForm({ response_format: "xml" }), /response_format/],
    [nomilyForm({ language: "not a language" }), /ISO-639-1/],
    [nomilyForm({ temperature: "2" }), /temperature/],
    [nomilyForm({ stream: "true" }), /stream=true is not supported/],
    // Proxy's decision: known speakers cannot be honoured by either upstream, so refuse them.
    [nomilyForm({ "known_speaker_names[]": ["agent"] }), /known_speaker_names is not supported/],
    [nomilyForm({ unknown_field: "1" }), /unknown_field|Unrecognized/i],
  ];
  for (const [form, pattern] of cases) {
    const response = await post(form);
    assert.equal(response.status, 400, String(pattern));
    assert.match(await errorMessage(response), pattern);
  }
});

test("an empty file is a 400", async () => {
  const form = nomilyForm({}, false);
  form.append("file", new File([], "audio.ogg"));
  const response = await post(form);
  assert.equal(response.status, 400);
  assert.equal(await errorMessage(response), "file is empty");
});

test("an upload declared above the limit is refused before it is read", async () => {
  const response = await route.POST(
    new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_BODY_BYTES_TRANSCRIPTION + 1),
      },
      body: "--x--",
    })
  );
  assert.equal(response.status, 413);
});

test("repeated name[] parts collect into arrays; plain repeats do not", () => {
  const form = nomilyForm({
    "timestamp_granularities[]": ["word", "segment"],
    "keywords[]": ["Nomily"],
  });
  const collected = route.collectTranscriptionForm(form);
  assert.ok(collected.ok);
  if (!collected.ok) return;
  assert.deepEqual(collected.fields.timestamp_granularities, ["word", "segment"]);
  assert.deepEqual(collected.fields.keywords, ["Nomily"]);
  assert.equal(collected.file.name, "audio.ogg");

  const twoFiles = nomilyForm();
  twoFiles.append("file", new File([new Uint8Array([1])], "b.ogg"));
  assert.deepEqual(route.collectTranscriptionForm(twoFiles), {
    ok: false,
    message: "Send exactly one file",
  });
});

test("a key denied by its endpoint policy is refused before the upload is read", async () => {
  const key = await apiKey({ allowedEndpoints: ["chat"] });
  const { request, state } = streamedPost({ key });
  const response = await route.POST(request);
  assert.equal(response.status, 403);
  assert.match(await errorMessage(response), /audio-transcriptions/);
  assert.equal(state.pulled, false, "no byte of the upload was read");
});

test("each request is charged once, before its upload; a spent key is refused unread", async () => {
  const key = await apiKey({ rateLimits: [{ limit: 2, window: 60 }] });
  for (let i = 0; i < 2; i++) {
    const { request, state } = streamedPost({ key });
    const response = await route.POST(request);
    // Through admission (the one charge), parsing and the model policy (no charge), up to
    // credential selection. A second charge at the model step would make request 2 a 429.
    assert.equal(response.status, 400, `request ${i + 1}`);
    assert.equal(await errorMessage(response), PAST_MODEL_POLICY);
    assert.equal(state.pulled, true);
  }
  const { request, state } = streamedPost({ key });
  const third = await route.POST(request);
  assert.equal(third.status, 429);
  assert.equal(state.pulled, false, "a rate-limited key costs no buffering");
});

test("conversion needs an API key: keyless Ogg is refused, a valid key reaches ffmpeg", async () => {
  await providersDb.createProviderConnection({
    provider: "azure-speech",
    authType: "apikey",
    name: "azure-speech-conn",
    apiKey: "speech-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://eastus.api.cognitive.microsoft.com" },
  });
  const ogg = () => {
    const form = nomilyForm({ model: "azure-speech/mai-transcribe-2" }, false);
    form.append("file", new File([OGG], "memo.ogg", { type: "audio/ogg" }));
    return form;
  };

  const keyless = await post(ogg());
  assert.equal(keyless.status, 401);
  assert.match(await errorMessage(keyless), /needs an API key/);

  // With a key the route lets the conversion start. An empty PATH makes it stop right there
  // (ffmpeg missing) instead of calling Azure, which proves it was allowed to run.
  const key = await apiKey();
  const originalPath = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "stt-empty-path-"));
  try {
    const keyed = await post(ogg(), { Authorization: `Bearer ${key}` });
    assert.equal(keyed.status, 500);
    assert.match(await errorMessage(keyed), /ffmpeg is not installed/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("stalled uploads hold the four slots; a timed-out upload gives its slot back", async () => {
  route.__setUploadTimeoutsForTest({ idleTimeoutMs: 1000, totalTimeoutMs: 10_000 });
  try {
    const uploads = Array.from({ length: route.MAX_IN_FLIGHT_TRANSCRIPTIONS }, () =>
      streamedPost({ stall: true })
    );
    const stalled = uploads.map(({ request }) => route.POST(request));
    // A body is read only after its request holds a slot, so this waits for all four slots.
    for (const started = Date.now(); !uploads.every(({ state }) => state.pulled);) {
      assert.ok(Date.now() - started < 5000, "the four uploads never started reading");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const extra = streamedPost();
    const busy = await route.POST(extra.request);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("Retry-After"), "5");
    assert.equal(extra.state.pulled, false);

    for (const response of await Promise.all(stalled)) assert.equal(response.status, 408);
    const after = await route.POST(streamedPost().request);
    assert.equal(after.status, 400);
    assert.equal(await errorMessage(after), PAST_MODEL_POLICY, "a released slot was taken");
  } finally {
    route.__setUploadTimeoutsForTest();
  }
});

test("OPTIONS answers the CORS preflight", async () => {
  const response = await route.OPTIONS();
  assert.match(response.headers.get("access-control-allow-methods") || "", /POST/);
});
