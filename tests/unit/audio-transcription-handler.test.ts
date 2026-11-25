import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stt-handler-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const handler = await import("../../open-sse/handlers/audioTranscription.ts");
const registry = await import("../../open-sse/config/transcriptionRegistry.ts");
const { AudioTranscodeError } = await import("../../open-sse/utils/audioTranscode.ts");
const { V1_TRANSCRIPTION_RESPONSE_FORMATS } =
  await import("../../src/shared/validation/schemas/apiV1.ts");

test.after(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

const WAV = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt \x10\0\0\0");
const OGG = new Uint8Array(
  fs.readFileSync(new URL("../fixtures/audio/sine-440hz-3s-opus.ogg", import.meta.url))
);

type Request = Parameters<typeof handler.handleAudioTranscription>[0]["request"];

function resolve(model: string) {
  const resolved = registry.resolveTranscriptionModel(model);
  assert.ok(resolved.ok, model);
  return resolved as Extract<typeof resolved, { ok: true }>;
}

function sttRequest(overrides: Partial<Request> = {}): Request {
  return {
    file: new File([WAV], "note.wav", { type: "audio/wav" }),
    responseFormat: "json",
    timestampGranularities: [],
    keywords: [],
    ...overrides,
  };
}

/** A fetch that records each call and answers with `answer`. */
function recordingFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const AZURE_RESULT = {
  durationMilliseconds: 4200,
  combinedPhrases: [{ text: "Hello there. Hi." }],
  phrases: [
    {
      offsetMilliseconds: 0,
      durationMilliseconds: 1500,
      text: "Hello there.",
      speaker: 0,
      locale: "en-US",
      words: [
        { text: "Hello", offsetMilliseconds: 0, durationMilliseconds: 600 },
        { text: "there.", offsetMilliseconds: 600, durationMilliseconds: 900 },
      ],
    },
    { offsetMilliseconds: 2000, durationMilliseconds: 1000, text: "Hi.", speaker: 1 },
  ],
};

const azureCredentials = {
  apiKey: "azure-key",
  baseUrl: "https://eastus.api.cognitive.microsoft.com",
};

test("the handler's response formats are exactly the ones the route schema accepts", () => {
  assert.deepEqual(
    [...handler.TRANSCRIPTION_RESPONSE_FORMATS],
    [...V1_TRANSCRIPTION_RESPONSE_FORMATS]
  );
});

test("Azure definition selects MAI-Transcribe-2 in clean style with the timestamps a format needs", () => {
  const { model } = resolve("azure-speech/mai-transcribe-2");
  assert.deepEqual(handler.buildAzureDefinition(sttRequest(), model), {
    enhancedMode: {
      enabled: true,
      model: "MAI-Transcribe-2",
      modelOptions: { transcribeStyle: "clean" },
    },
  });
  const verbose = handler.buildAzureDefinition(
    sttRequest({
      responseFormat: "verbose_json",
      timestampGranularities: ["word"],
      language: "ko",
      keywords: ["Nomily"],
    }),
    model
  );
  assert.deepEqual(verbose, {
    enhancedMode: {
      enabled: true,
      model: "MAI-Transcribe-2",
      modelOptions: { transcribeStyle: "clean", timestamps: "word" },
    },
    locales: ["ko"],
    phraseList: { phrases: ["Nomily"] },
  });
  for (const responseFormat of ["srt", "vtt", "verbose_json"] as const) {
    const definition = handler.buildAzureDefinition(sttRequest({ responseFormat }), model);
    assert.equal(
      (definition.enhancedMode as { modelOptions: { timestamps: string } }).modelOptions.timestamps,
      "segment",
      responseFormat
    );
  }
  const diarized = handler.buildAzureDefinition(
    sttRequest({ responseFormat: "diarized_json" }),
    model
  );
  assert.deepEqual(diarized.diarization, { enabled: true });
});

test("MAI-Transcribe-1.5 gets no modelOptions, which only MAI-Transcribe-2 documents", () => {
  const { model } = resolve("azure-speech/mai-transcribe-1.5");
  assert.deepEqual(
    handler.buildAzureDefinition(sttRequest({ responseFormat: "verbose_json" }), model),
    {
      enhancedMode: { enabled: true, model: "MAI-Transcribe-1.5" },
    }
  );
});

test("OpenRouter body follows its STT contract per model", () => {
  const audio = { bytes: new Uint8Array([1, 2, 3]), format: "ogg" };
  const mai2 = resolve("openrouter/microsoft/mai-transcribe-2").model;
  assert.deepEqual(
    handler.buildOpenRouterBody(
      sttRequest({
        responseFormat: "verbose_json",
        timestampGranularities: ["word"],
        keywords: ["x"],
      }),
      mai2,
      audio
    ),
    {
      model: "microsoft/mai-transcribe-2",
      input_audio: { data: "AQID", format: "ogg" },
      keyterms: ["x"],
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    }
  );
  // OpenRouter documents diarization for MAI through the Azure endpoint's own option.
  const diarizedMai = handler.buildOpenRouterBody(
    sttRequest({ responseFormat: "diarized_json" }),
    mai2,
    audio
  );
  assert.deepEqual(diarizedMai.provider, {
    options: { azure: { diarization: { enabled: true } } },
  });
  assert.equal(diarizedMai.diarize, undefined);
  const nova = resolve("openrouter/deepgram/nova-3").model;
  assert.equal(
    handler.buildOpenRouterBody(sttRequest({ responseFormat: "diarized_json" }), nova, audio)
      .diarize,
    true
  );
  // OpenRouter rejects verbose_json for these models, so they are asked for plain json.
  for (const id of [
    "openrouter/microsoft/mai-transcribe-1.5",
    "openrouter/openai/gpt-4o-transcribe",
  ]) {
    const body = handler.buildOpenRouterBody(
      sttRequest({ responseFormat: "verbose_json" }),
      resolve(id).model,
      audio
    );
    assert.equal(body.response_format, undefined, id);
  }
  // text, srt and vtt are a 400 upstream: srt/vtt are built from verbose_json, text from json.
  assert.equal(
    handler.buildOpenRouterBody(sttRequest({ responseFormat: "srt" }), mai2, audio).response_format,
    "verbose_json"
  );
  assert.equal(
    handler.buildOpenRouterBody(sttRequest({ responseFormat: "text" }), mai2, audio)
      .response_format,
    undefined
  );
});

test("Azure phrases map to OpenAI segments, words and duration", () => {
  const transcript = handler.azureToTranscript(AZURE_RESULT, null);
  assert.equal(transcript.text, "Hello there. Hi.");
  assert.equal(transcript.language, "en-US");
  assert.equal(transcript.durationSeconds, 4.2);
  assert.deepEqual(transcript.segments, [
    { start: 0, end: 1.5, text: "Hello there.", speaker: 0 },
    { start: 2, end: 3, text: "Hi.", speaker: 1 },
  ]);
  assert.deepEqual(transcript.words, [
    { word: "Hello", start: 0, end: 0.6 },
    { word: "there.", start: 0.6, end: 1.5 },
  ]);
});

test("each response format has OpenAI's shape", () => {
  const transcript = handler.azureToTranscript(AZURE_RESULT, null);
  const json = JSON.parse(handler.formatTranscript(transcript, "json", []).body);
  assert.deepEqual(json, { text: "Hello there. Hi.", usage: { type: "duration", seconds: 4.2 } });

  const text = handler.formatTranscript(transcript, "text", []);
  assert.equal(text.body, "Hello there. Hi.");
  assert.match(text.contentType, /^text\/plain/);

  const verbose = JSON.parse(handler.formatTranscript(transcript, "verbose_json", []).body);
  assert.equal(verbose.task, "transcribe");
  assert.equal(verbose.duration, 4.2);
  assert.deepEqual(verbose.segments[1], { id: 1, start: 2, end: 3, text: "Hi." });
  assert.equal(verbose.words, undefined, "words only when requested");
  const withWords = JSON.parse(handler.formatTranscript(transcript, "verbose_json", ["word"]).body);
  assert.equal(withWords.words.length, 2);
  assert.equal(withWords.segments, undefined, "segments only when requested with word");

  const diarized = JSON.parse(handler.formatTranscript(transcript, "diarized_json", []).body);
  assert.deepEqual(
    diarized.segments.map((s: { id: string; speaker: string; type: string }) => [
      s.id,
      s.speaker,
      s.type,
    ]),
    [
      ["seg_001", "A", "transcript.text.segment"],
      ["seg_002", "B", "transcript.text.segment"],
    ]
  );

  assert.equal(
    handler.formatTranscript(transcript, "srt", []).body,
    "1\n00:00:00,000 --> 00:00:01,500\nHello there.\n\n2\n00:00:02,000 --> 00:00:03,000\nHi.\n"
  );
  assert.equal(
    handler.formatTranscript(transcript, "vtt", []).body,
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello there.\n\n00:00:02.000 --> 00:00:03.000\nHi.\n"
  );
});

test("subtitles without segments are one cue, and cue text cannot break the format", () => {
  const body = handler.buildSubtitles(
    {
      text: "a --> b\n\nc",
      language: null,
      durationSeconds: 2,
      segments: [],
      words: [],
      reportedCostUsd: null,
    },
    "srt"
  );
  assert.equal(body, "1\n00:00:00,000 --> 00:00:02,000\na -> b\nc\n");
});

test("Azure call: endpoint, key header, no redirects, JSON definition part, transcoded FLAC", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const { calls, fetchImpl } = recordingFetch(() => Response.json(AZURE_RESULT));
  const transcodes: unknown[] = [];
  const transcodeImpl = (async (_bytes: Uint8Array, options: unknown) => {
    transcodes.push(options);
    return new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
  }) as typeof import("../../open-sse/utils/audioTranscode.ts").transcodeToFlac;
  let recorded: unknown = null;

  const response = await handler.handleAudioTranscription({
    request: sttRequest({
      file: new File([OGG], "memo.ogg", { type: "audio/ogg" }),
      responseFormat: "verbose_json",
    }),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
    transcodeImpl,
    allowTranscode: true,
    onSuccess: async (result) => {
      recorded = result;
      return null;
    },
  });

  assert.equal(response.status, 200);
  assert.equal(transcodes.length, 1, "Ogg/Opus is converted; MAI documents WAV, MP3 and FLAC only");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"],
    "azure-key"
  );
  assert.equal(calls[0].init.redirect, "error");
  const form = calls[0].init.body as FormData;
  const audio = form.get("audio") as File;
  assert.equal(audio.name, "audio.flac");
  const definition = form.get("definition") as File;
  assert.equal(definition.type, "application/json");
  assert.equal(JSON.parse(await definition.text()).enhancedMode.model, "MAI-Transcribe-2");

  const body = await response.json();
  assert.equal(body.text, "Hello there. Hi.");
  assert.equal(body.segments.length, 2);
  assert.deepEqual(
    { audioSeconds: (recorded as { audioSeconds: number }).audioSeconds },
    { audioSeconds: 4.2 }
  );
  assert.equal(response.headers.get("X-OmniRoute-Response-Cost"), null, "no guessed cost");
});

test("bytes that are no known container are a 400 and never reach ffmpeg or the upstream", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const response = await handler.handleAudioTranscription({
    request: sttRequest({
      file: new File([new TextEncoder().encode("#EXTM3U\nhttp://x/a.ts\n")], "a.ogg", {
        type: "audio/ogg",
      }),
    }),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl: (async () => assert.fail("no upstream call")) as never,
    transcodeImpl: (async () => assert.fail("no conversion")) as never,
    allowTranscode: true,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /not a recognised audio or video container/);
});

test("a request without an API key may not start a conversion", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const response = await handler.handleAudioTranscription({
    request: sttRequest({ file: new File([OGG], "memo.ogg") }),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl: (async () => assert.fail("no upstream call")) as never,
    transcodeImpl: (async () => assert.fail("no conversion")) as never,
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /needs an API key/);
});

test("the container comes from the bytes, not the name the client gave", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const { calls, fetchImpl } = recordingFetch(() => Response.json(AZURE_RESULT));
  const response = await handler.handleAudioTranscription({
    request: sttRequest({ file: new File([WAV], "memo.ogg", { type: "audio/ogg" }) }),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
    transcodeImpl: (async () => assert.fail("WAV needs no conversion")) as never,
  });
  assert.equal(response.status, 200);
  assert.equal(((calls[0].init.body as FormData).get("audio") as File).name, "audio.wav");
});

test("an upload Azure accepts is sent as is", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const { calls, fetchImpl } = recordingFetch(() => Response.json(AZURE_RESULT));
  let transcoded = false;
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
    transcodeImpl: (async () => {
      transcoded = true;
      return new Uint8Array();
    }) as never,
  });
  assert.equal(response.status, 200);
  assert.equal(transcoded, false);
  assert.equal(((calls[0].init.body as FormData).get("audio") as File).name, "audio.wav");
});

test("OpenRouter call: bearer key, base64 JSON, Ogg sent without conversion, reported cost kept", async () => {
  const { provider, model } = resolve("openrouter/microsoft/mai-transcribe-2");
  const { calls, fetchImpl } = recordingFetch(() =>
    Response.json({ text: "hi", usage: { seconds: 3, cost: 0.0001 } })
  );
  let costSeen: number | null = null;
  const response = await handler.handleAudioTranscription({
    request: sttRequest({ file: new File([OGG], "memo.ogg") }),
    provider,
    model,
    credentials: { apiKey: "or-key" },
    fetchImpl,
    transcodeImpl: (async () => assert.fail("OpenRouter takes Ogg")) as never,
    onSuccess: async (result) => {
      costSeen = result.reportedCostUsd;
      return result.reportedCostUsd;
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer or-key");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent.input_audio, { data: Buffer.from(OGG).toString("base64"), format: "ogg" });
  assert.equal(costSeen, 0.0001);
  assert.deepEqual(await response.json(), { text: "hi", usage: { type: "duration", seconds: 3 } });
});

test("upstream errors keep their status and are sanitized", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const { fetchImpl } = recordingFetch(
    () => new Response(JSON.stringify({ error: { message: "Access denied" } }), { status: 401 })
  );
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
  });
  assert.equal(response.status, 401);
});

test("a connection without an https endpoint is refused before any call", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const { calls, fetchImpl } = recordingFetch(() => Response.json(AZURE_RESULT));
  for (const baseUrl of [undefined, "eastus", "http://eastus.api.cognitive.microsoft.com"]) {
    const response = await handler.handleAudioTranscription({
      request: sttRequest(),
      provider,
      model,
      credentials: { apiKey: "k", baseUrl },
      fetchImpl,
    });
    assert.equal(response.status, 400, String(baseUrl));
  }
  assert.equal(calls.length, 0);
});

test("the default upstream fetch applies the outbound URL policy", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  // Cloud metadata stays blocked under every policy mode.
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: { apiKey: "k", baseUrl: "https://169.254.169.254" },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /outbound URL policy/);
});

test("diarized_json on a model without speaker labels is a 400", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-1.5");
  const response = await handler.handleAudioTranscription({
    request: sttRequest({ responseFormat: "diarized_json" }),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl: (async () => assert.fail("no upstream call")) as never,
  });
  assert.equal(response.status, 400);
});

test("conversion errors map to client-facing statuses", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const cases = [
    ["busy", 503],
    ["decode_failed", 400],
    ["output_too_large", 413],
    ["timeout", 504],
  ] as const;
  for (const [code, status] of cases) {
    const response = await handler.handleAudioTranscription({
      request: sttRequest({ file: new File([OGG], "memo.ogg") }),
      provider,
      model,
      credentials: azureCredentials,
      fetchImpl: (async () => assert.fail("no upstream call")) as never,
      transcodeImpl: (async () => {
        throw new AudioTranscodeError(code, "x");
      }) as never,
      allowTranscode: true,
    });
    assert.equal(response.status, status, code);
    if (code === "busy") assert.equal(response.headers.get("Retry-After"), "5");
  }
});

test("a client that leaves during the upstream call is not reported as a provider failure", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const controller = new AbortController();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    controller.abort();
    throw init?.signal?.reason ?? new Error("aborted");
  }) as typeof fetch;
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(response.status, 408);
});

test("an abort while reading the upstream body is not reported as an unreadable response", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  const controller = new AbortController();
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        pull() {
          controller.abort();
          throw new Error("body aborted");
        },
      })
    )) as typeof fetch;
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(response.status, 408);
});

test("an Azure answer without phrase arrays is a 502, never an empty success", async () => {
  const { provider, model } = resolve("azure-speech/mai-transcribe-2");
  for (const body of [
    {},
    [],
    { error: "x" },
    "text",
    { combinedPhrases: [null] },
    { combinedPhrases: [{}] },
    { phrases: [{ text: 1 }] },
    { combinedPhrases: [], phrases: "x" },
  ]) {
    let recorded = false;
    const response = await handler.handleAudioTranscription({
      request: sttRequest(),
      provider,
      model,
      credentials: azureCredentials,
      fetchImpl: (async () => Response.json(body)) as never,
      onSuccess: async () => {
        recorded = true;
        return null;
      },
    });
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(recorded, false);
  }
  // Silence: Azure answers empty arrays, which is a real, empty transcript.
  const silent = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: azureCredentials,
    fetchImpl: (async () =>
      Response.json({ durationMilliseconds: 1000, combinedPhrases: [], phrases: [] })) as never,
  });
  assert.equal(silent.status, 200);
  assert.equal((await silent.json()).text, "");
});

test("a network failure is a sanitized 502", async () => {
  const { provider, model } = resolve("openrouter/microsoft/mai-transcribe-2");
  const response = await handler.handleAudioTranscription({
    request: sttRequest(),
    provider,
    model,
    credentials: { apiKey: "k" },
    fetchImpl: (async () => {
      throw new Error("connect ECONNREFUSED /secret/path");
    }) as never,
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret|ECONNREFUSED/);
});
