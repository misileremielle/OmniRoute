import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ALLOWED_INPUT_DEMUXERS,
  AudioTranscodeError,
  MAX_CONCURRENT_TRANSCODES,
  MAX_QUEUED_TRANSCODES,
  buildFlacTranscodeArgs,
  sniffAudioContainer,
  transcodeToFlac,
} from "../../open-sse/utils/audioTranscode.ts";

const OGG = { format: "ogg", demuxer: "ogg" } as const;
const WEBM = { format: "webm", demuxer: "matroska" } as const;
const M4A = { format: "m4a", demuxer: "mov" } as const;
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)));

type FakeBehaviour =
  | { kind: "ok"; output: Uint8Array }
  | { kind: "exit"; code: number; stderr?: string }
  | { kind: "enoent" }
  | { kind: "hang" };

function fakeSpawn(behaviour: FakeBehaviour) {
  const calls: { command: string; args: readonly string[]; options: unknown; killed: string[] }[] =
    [];
  const spawnImpl = (command: string, args: readonly string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    const call = { command, args, options, killed: [] as string[] };
    calls.push(call);
    child.stderr = new PassThrough();
    child.kill = (signal?: string) => {
      call.killed.push(signal ?? "SIGTERM");
      return true;
    };
    setImmediate(() => {
      if (behaviour.kind === "enoent") {
        const error = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
        child.emit("error", error);
      } else if (behaviour.kind === "ok") {
        writeFileSync(args[args.length - 1], behaviour.output);
        child.emit("close", 0, null);
      } else if (behaviour.kind === "exit") {
        child.stderr.write(behaviour.stderr ?? "");
        child.emit("close", behaviour.code, null);
      }
    });
    return child as never;
  };
  return { spawnImpl, calls };
}

function sttTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("omniroute-stt-"));
}

test("real recordings are identified from their bytes, whatever they are called", () => {
  assert.deepEqual(sniffAudioContainer(fixture("sine-440hz-3s-opus.ogg")), OGG);
  assert.deepEqual(sniffAudioContainer(fixture("sine-440hz-0.5s-aac.m4a")), M4A);
  assert.deepEqual(sniffAudioContainer(fixture("sine-440hz-0.5s-opus.webm")), WEBM);
});

test("headers that only look like a container are refused before ffmpeg", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const m4a = fixture("sine-440hz-0.5s-aac.m4a");
  const ogg = fixture("sine-440hz-3s-opus.ogg");
  const notAudio: Record<string, Uint8Array> = {
    "Ogg magic, junk after": enc("OggS" + "x".repeat(60)),
    "Ogg page without an audio head": (() => {
      const copy = ogg.slice(0, 64);
      copy.set(enc("NotOpus!"), 27 + copy[26]);
      return copy;
    })(),
    "truncated m4a": m4a.slice(0, m4a.length - 100),
    "m4a with trailing bytes": new Uint8Array([...m4a, 1, 2, 3, 4]),
    "valid ftyp brand, then junk": enc("\0\0\0\x18ftypM4A \0\0\0\0M4A isomjunkjunkjunk"),
    "EBML magic, no DocType": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...enc("x".repeat(60))]),
    "HLS playlist": enc("#EXTM3U\n#EXTINF:2,\nhttp://127.0.0.1:9/x.ts\n"),
    "ffconcat list": enc("ffconcat version 1.0\nfile /etc/passwd\n"),
    "ADTS sync, bad frame length": new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]),
    empty: new Uint8Array(),
  };
  for (const [name, bytes] of Object.entries(notAudio)) {
    assert.equal(sniffAudioContainer(bytes), null, name);
  }
});

/** An MP4 box: 32-bit size, four-letter type, payload. */
function mp4Box(type: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const box = new Uint8Array(8 + payload.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(new TextEncoder().encode(type), 4);
  box.set(payload, 8);
  return box;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const FTYP = mp4Box("ftyp", new TextEncoder().encode("M4A \0\0\0\0M4A isom"));
const hdlr = (handler: string) =>
  mp4Box("hdlr", concat(new Uint8Array(8), new TextEncoder().encode(handler), new Uint8Array(12)));
const movie = (...trackChildren: Uint8Array[]) =>
  mp4Box("moov", mp4Box("trak", mp4Box("mdia", concat(...trackChildren))));

test("an MP4 needs a real sound or video track, found by walking moov/trak/mdia/hdlr", () => {
  const samples = mp4Box("mdat", new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(sniffAudioContainer(concat(FTYP, movie(hdlr("soun")), samples)), M4A);
  assert.deepEqual(sniffAudioContainer(concat(FTYP, samples, movie(hdlr("vide")))), M4A);
  // A media track with no sample data has nothing to decode.
  assert.equal(sniffAudioContainer(concat(FTYP, movie(hdlr("soun")))), null);
  assert.equal(sniffAudioContainer(concat(FTYP, movie(hdlr("soun")), mp4Box("mdat"))), null);
  // A metadata-only track, and the right bytes in the wrong box, are not media.
  assert.equal(sniffAudioContainer(concat(FTYP, movie(hdlr("meta")), samples)), null);
  const fakeHandler = mp4Box("udta", new TextEncoder().encode("hdlr\0\0\0\0\0\0\0\0soun"));
  assert.equal(
    sniffAudioContainer(concat(FTYP, mp4Box("moov", mp4Box("trak", fakeHandler)), samples)),
    null
  );
  assert.equal(sniffAudioContainer(concat(FTYP, mp4Box("mdat"))), null, "no moov");
  // A child that overruns its parent is a forged size.
  const overrun = movie(hdlr("soun"));
  new DataView(overrun.buffer).setUint32(8, overrun.length);
  assert.equal(sniffAudioContainer(concat(FTYP, overrun, samples)), null);
});

test("MP4 sniffing stays cheap near the upload limit and on box floods", () => {
  const large = concat(
    fixture("sine-440hz-0.5s-aac.m4a"),
    mp4Box("free", new Uint8Array(64 * 1024 * 1024))
  );
  let started = performance.now();
  assert.deepEqual(sniffAudioContainer(large), M4A);
  assert.ok(performance.now() - started < 250, "box sizes are followed, bytes are not scanned");

  // Each mdia holds only 1,000 boxes, which no per-parent cap would refuse; together 120,000
  // boxes come before the one real sound track. Only a budget shared by the whole walk stops it.
  const filler = new Uint8Array(1000 * 8);
  for (let at = 0; at < filler.length; at += 8) filler.set(mp4Box("free"), at);
  const decoys = Array.from({ length: 120 }, () => mp4Box("trak", mp4Box("mdia", filler)));
  const realTrack = mp4Box("trak", mp4Box("mdia", hdlr("soun")));
  const samples = mp4Box("mdat", new Uint8Array([1, 2, 3, 4]));
  const flood = concat(FTYP, mp4Box("moov", concat(...decoys, realTrack)), samples);
  started = performance.now();
  assert.equal(sniffAudioContainer(flood), null);
  assert.ok(performance.now() - started < 250, "the shared box budget stops the walk");
  // The same file with a few decoys is fine: the budget only bites on floods.
  const few = concat(FTYP, mp4Box("moov", concat(...decoys.slice(0, 5), realTrack)), samples);
  assert.deepEqual(sniffAudioContainer(few), M4A);
  // A fragmented layout with thousands of moof/mdat pairs stays under the budget.
  const fragments = Array.from({ length: 5000 }, () => concat(mp4Box("moof"), samples));
  assert.deepEqual(sniffAudioContainer(concat(FTYP, mp4Box("moov", realTrack), ...fragments)), M4A);
});

test("the other listed containers are identified from their headers", () => {
  // Two ADTS frames of 9 bytes each (7-byte header, no CRC, length 9).
  const adtsFrame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0x00, 0x00];
  assert.deepEqual(sniffAudioContainer(new Uint8Array([...adtsFrame, ...adtsFrame])), {
    format: "aac",
    demuxer: "aac",
  });
  // MPEG-2 program stream pack header with its marker bits set.
  const pack = [0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x89, 0xc3];
  assert.deepEqual(sniffAudioContainer(new Uint8Array(pack)), { format: "mpeg", demuxer: "mpeg" });
  const enc = (text: string) => new TextEncoder().encode(text);
  assert.equal(sniffAudioContainer(enc("RIFF\0\0\0\0WAVEfmt "))?.format, "wav");
  assert.equal(sniffAudioContainer(enc("fLaC\0\0\0\x22"))?.format, "flac");
  assert.equal(sniffAudioContainer(enc("ID3\x04\0\0"))?.format, "mp3");
  assert.equal(sniffAudioContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))?.format, "mp3");
});

test("ffmpeg gets an argument array that writes 16 kHz mono FLAC, never a shell", async () => {
  const before = new Set(sttTempDirs());
  const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 1, 2, 3]);
  const { spawnImpl, calls } = fakeSpawn({ kind: "ok", output: flac });

  const out = await transcodeToFlac(new Uint8Array([1, 2, 3]), {
    container: OGG,
    maxOutputBytes: 1024,
    spawnImpl,
  });

  assert.deepEqual([...out], [...flac]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg");
  assert.deepEqual(calls[0].options, {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    windowsHide: true,
  });
  const args = calls[0].args;
  assert.match(args[args.indexOf("-i") + 1], /omniroute-stt-[^/]+\/input\.ogg$/);
  // Input confinement comes before -i, so it applies to the upload.
  const inputAt = args.indexOf("-i");
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
  // Only the sniffed demuxer may read the upload, forced so ffmpeg never probes.
  assert.equal(args[args.indexOf("-format_whitelist") + 1], "ogg");
  assert.equal(args[inputAt - 2], "-f");
  assert.equal(args[inputAt - 1], "ogg");
  assert.ok(args.indexOf("-protocol_whitelist") < inputAt);
  assert.ok(args.indexOf("-format_whitelist") < inputAt);
  assert.deepEqual(args.slice(args.indexOf("-vn"), -1), [
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    "-fs",
    "1025",
    "-f",
    "flac",
  ]);
  // The temp directory is gone once the call returns.
  assert.deepEqual(
    sttTempDirs().filter((name) => !before.has(name)),
    []
  );
});

test("a demuxer outside the allowlist is refused before any spawn", () => {
  for (const demuxer of ["hls", "concat", "image2", "ogg,hls", ""]) {
    assert.throws(
      () => buildFlacTranscodeArgs("/t/input.bin", "/t/output.flac", 10, demuxer),
      (error: unknown) => error instanceof AudioTranscodeError && error.code === "decode_failed",
      demuxer
    );
  }
  const args = buildFlacTranscodeArgs("/t/input.m4a", "/t/output.flac", 10, "mov");
  assert.equal(args[args.indexOf("-i") + 1], "/t/input.m4a");
  assert.equal(args.at(-1), "/t/output.flac");
});

for (const [name, behaviour, code] of [
  ["a missing ffmpeg binary", { kind: "enoent" }, "ffmpeg_missing"],
  [
    "a non-zero ffmpeg exit",
    { kind: "exit", code: 1, stderr: "Invalid data found" },
    "decode_failed",
  ],
  ["an empty FLAC output", { kind: "ok", output: new Uint8Array() }, "decode_failed"],
] as const) {
  test(`${name} becomes AudioTranscodeError(${code}) with a client-safe message`, async () => {
    const before = new Set(sttTempDirs());
    const { spawnImpl } = fakeSpawn(behaviour as FakeBehaviour);
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      await assert.rejects(
        transcodeToFlac(new Uint8Array([9]), {
          container: WEBM,
          maxOutputBytes: 10,
          spawnImpl,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AudioTranscodeError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /omniroute-stt-|Invalid data found|\//);
          return true;
        }
      );
    } finally {
      console.warn = originalWarn;
    }
    if (code === "decode_failed" && (behaviour as FakeBehaviour).kind === "exit") {
      assert.match(JSON.stringify(warnings), /Invalid data found/, "stderr goes to the server log");
    }
    assert.deepEqual(
      sttTempDirs().filter((dir) => !before.has(dir)),
      []
    );
  });
}

test("no demuxer that can reference other files or URLs is allowed", () => {
  for (const name of ["hls", "applehttp", "concat", "ffconcat", "image2", "tee", "dash", "sdp"]) {
    assert.ok(!ALLOWED_INPUT_DEMUXERS.includes(name), `${name} must stay off the allowlist`);
  }
});

/** A spawn whose children finish only when the test releases them, one at a time. */
function gatedSpawn() {
  const release: (() => void)[] = [];
  const kills: string[] = [];
  let running = 0;
  let peak = 0;
  let spawned = 0;
  const spawnImpl = (_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stderr = new PassThrough();
    let killed = false;
    child.kill = (signal?: string) => {
      kills.push(signal ?? "SIGTERM");
      if (!killed) running--;
      killed = true;
      return true;
    };
    spawned++;
    running++;
    peak = Math.max(peak, running);
    release.push(() => {
      if (killed) return child.emit("close", null, "SIGKILL");
      writeFileSync(args[args.length - 1], new Uint8Array([1]));
      running--;
      child.emit("close", 0, null);
    });
    return child as never;
  };
  return {
    spawnImpl,
    release,
    peak: () => peak,
    running: () => running,
    spawned: () => spawned,
    kills: () => kills,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Wait for a condition; the helper spawns only after its temp-file I/O, so ticks can't be counted. */
async function until(condition: () => boolean, what: string) {
  for (const start = Date.now(); !condition(); await tick()) {
    if (Date.now() - start > 5000) assert.fail(`timed out waiting for ${what}`);
  }
}

// The slot pool is module state: a test that left a child unreleased would stall the next ones
// for the whole queue deadline, so each queue test also has a timeout of its own.
const queueTest = { timeout: 15_000 };

test(
  "at most two conversions run at once; four more wait; the next is refused as busy",
  queueTest,
  async () => {
    const gate = gatedSpawn();
    const start = () =>
      transcodeToFlac(new Uint8Array([1]), {
        container: OGG,
        maxOutputBytes: 10,
        spawnImpl: gate.spawnImpl,
      });
    const admitted = Array.from(
      { length: MAX_CONCURRENT_TRANSCODES + MAX_QUEUED_TRANSCODES },
      start
    );
    await until(() => gate.spawned() === MAX_CONCURRENT_TRANSCODES, "the first two spawns");
    await assert.rejects(
      start(),
      (error: unknown) => error instanceof AudioTranscodeError && error.code === "busy"
    );
    await drain(gate, admitted);
    await Promise.all(admitted);
    assert.equal(gate.peak(), MAX_CONCURRENT_TRANSCODES);
    // The slots are free again afterwards.
    const after = start();
    await until(() => gate.release.length === 1, "the follow-up spawn");
    gate.release.shift()?.();
    await after;
  }
);

async function drain(gate: ReturnType<typeof gatedSpawn>, jobs: Promise<unknown>[]) {
  const settled = jobs.map((job) =>
    job.then(
      () => true,
      () => true
    )
  );
  let done = 0;
  for (const job of settled) void job.then(() => done++);
  // Counts settled jobs, so one that rejects before spawning still ends the loop; the deadline
  // ends it if a job never settles.
  for (const start = Date.now(); done < jobs.length;) {
    if (Date.now() - start > 5000) assert.fail(`${jobs.length - done} conversions never settled`);
    await tick();
    gate.release.shift()?.();
  }
}

test("a waiting conversion leaves the queue when its client aborts", queueTest, async () => {
  const gate = gatedSpawn();
  const start = (signal?: AbortSignal) =>
    transcodeToFlac(new Uint8Array([1]), {
      container: OGG,
      maxOutputBytes: 10,
      spawnImpl: gate.spawnImpl,
      signal,
    });
  const running = [start(), start()];
  const controller = new AbortController();
  const waiting = start(controller.signal);
  await until(() => gate.spawned() === 2, "both slots to be running");
  controller.abort();
  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof AudioTranscodeError && error.code === "aborted"
  );
  // Its queue place is free: four more fit behind the two running.
  const queued = Array.from({ length: MAX_QUEUED_TRANSCODES }, () => start());
  await drain(gate, [...running, ...queued]);
  await Promise.all([...running, ...queued]);
  assert.equal(gate.spawned(), 2 + MAX_QUEUED_TRANSCODES);
});

test("aborting a running conversion kills ffmpeg and frees the slot", queueTest, async () => {
  const gate = gatedSpawn();
  const controller = new AbortController();
  const job = transcodeToFlac(new Uint8Array([1]), {
    container: OGG,
    maxOutputBytes: 10,
    spawnImpl: gate.spawnImpl,
    signal: controller.signal,
  });
  await until(() => gate.spawned() === 1, "ffmpeg to start");
  controller.abort();
  await assert.rejects(
    job,
    (error: unknown) => error instanceof AudioTranscodeError && error.code === "aborted"
  );
  assert.deepEqual(gate.kills(), ["SIGKILL"]);
  const after = Array.from({ length: MAX_CONCURRENT_TRANSCODES }, () =>
    transcodeToFlac(new Uint8Array([1]), {
      container: OGG,
      maxOutputBytes: 10,
      spawnImpl: gate.spawnImpl,
    })
  );
  await until(
    () => gate.spawned() === 1 + MAX_CONCURRENT_TRANSCODES,
    "both slots to be free again"
  );
  assert.equal(gate.running(), MAX_CONCURRENT_TRANSCODES);
  gate.release.shift()?.(); // the killed child's close event, which the helper ignores
  await drain(gate, after);
  await Promise.all(after);
});

test("a conversion that waits past the queue deadline is refused as busy", queueTest, async () => {
  const gate = gatedSpawn();
  const start = (maxQueueWaitMs?: number) =>
    transcodeToFlac(new Uint8Array([1]), {
      container: OGG,
      maxOutputBytes: 10,
      spawnImpl: gate.spawnImpl,
      maxQueueWaitMs,
    });
  const running = [start(), start()];
  await assert.rejects(
    start(20),
    (error: unknown) => error instanceof AudioTranscodeError && error.code === "busy"
  );
  await drain(gate, running);
  await Promise.all(running);
  assert.equal(gate.spawned(), 2);
});

test("output above the upstream limit is refused", async () => {
  const { spawnImpl } = fakeSpawn({ kind: "ok", output: new Uint8Array(11) });
  await assert.rejects(
    transcodeToFlac(new Uint8Array([1]), { container: M4A, maxOutputBytes: 10, spawnImpl }),
    (error: unknown) => error instanceof AudioTranscodeError && error.code === "output_too_large"
  );
});

test("a hung ffmpeg is killed with SIGKILL at the timeout", async () => {
  const { spawnImpl, calls } = fakeSpawn({ kind: "hang" });
  await assert.rejects(
    transcodeToFlac(new Uint8Array([1]), {
      container: OGG,
      maxOutputBytes: 10,
      timeoutMs: 20,
      spawnImpl,
    }),
    (error: unknown) => error instanceof AudioTranscodeError && error.code === "timeout"
  );
  assert.deepEqual(calls[0].killed, ["SIGKILL"]);
});

// A real ffmpeg: OMNIROUTE_TEST_FFMPEG names one explicitly, else `ffmpeg` on PATH. Only a
// missing binary (ENOENT) skips; a binary that exists but cannot start fails these tests.
const explicitFfmpeg = process.env.OMNIROUTE_TEST_FFMPEG;
const ffmpegPath = explicitFfmpeg || "ffmpeg";
// spawn also reports ENOENT when the binary exists but its ELF loader does not, so absence is
// decided by looking for the file, never from the spawn error.
const ffmpegOnPath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(Boolean)
  .some((dir) => existsSync(join(dir, "ffmpeg")));
const realFfmpeg = {
  skip:
    explicitFfmpeg || ffmpegOnPath ? false : "ffmpeg is not on PATH (set OMNIROUTE_TEST_FFMPEG)",
};

test("real ffmpeg starts", realFfmpeg, () => {
  // Inside the test and bounded, so a hanging binary is reported here instead of stalling load.
  const probe = spawnSync(ffmpegPath, ["-version"], {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  assert.equal(probe.error, undefined, `${ffmpegPath} could not start: ${probe.error?.message}`);
  assert.equal(probe.status, 0, probe.stderr);
});

test("real ffmpeg converts each fixture through its sniffed demuxer", realFfmpeg, async () => {
  for (const name of [
    "sine-440hz-3s-opus.ogg",
    "sine-440hz-0.5s-aac.m4a",
    "sine-440hz-0.5s-opus.webm",
  ]) {
    const bytes = fixture(name);
    const container = sniffAudioContainer(bytes);
    assert.ok(container, name);
    const flac = await transcodeToFlac(bytes, {
      container: container!,
      maxOutputBytes: 10 * 1024 * 1024,
      ffmpegPath,
    });
    assert.equal(Buffer.from(flac.subarray(0, 4)).toString("latin1"), "fLaC", name);
  }
});

test(
  "real ffmpeg does not fall back to probing when the forced demuxer is wrong",
  realFfmpeg,
  async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.rejects(
        transcodeToFlac(fixture("sine-440hz-0.5s-aac.m4a"), {
          container: OGG,
          maxOutputBytes: 1024 * 1024,
          ffmpegPath,
        }),
        (error: unknown) => error instanceof AudioTranscodeError && error.code === "decode_failed"
      );
    } finally {
      console.warn = originalWarn;
    }
  }
);

test("real ffmpeg refuses an HLS playlist uploaded as audio", realFfmpeg, async () => {
  const playlist = new TextEncoder().encode(
    "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n"
  );
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // The sniffer already refuses this; forcing the ogg demuxer on it must fail as well.
    assert.equal(sniffAudioContainer(playlist), null);
    for (const container of [OGG]) {
      await assert.rejects(
        transcodeToFlac(playlist, { container, maxOutputBytes: 1024 * 1024, ffmpegPath }),
        (error: unknown) => error instanceof AudioTranscodeError && error.code === "decode_failed"
      );
    }
  } finally {
    console.warn = originalWarn;
  }
});
