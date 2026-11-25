import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Audio format detection and FLAC conversion for /v1/audio/transcriptions.
 *
 * Some upstreams accept only a few containers (Azure MAI-Transcribe: WAV, MP3, FLAC) while
 * clients upload Ogg/Opus, WebM or M4A. Those uploads are converted to 16 kHz mono FLAC with
 * ffmpeg (installed in the Docker runtime image; see the Dockerfile `runtime-os` stage).
 *
 * The conversion goes through temp files, not pipes: an MP4/M4A whose `moov` atom sits at the
 * end of the file cannot be demuxed from a non-seekable stdin. ffmpeg is spawned with an
 * argument array and no shell, so no file name or format reaches a shell.
 */

/** Audio bytes backed by a plain ArrayBuffer, as `Blob` parts and `file.arrayBuffer()` need. */
export type AudioBytes = Uint8Array<ArrayBuffer>;

/**
 * An upload's container, identified from its own bytes. `format` is the name upstreams use
 * (and the temp file's extension); `demuxer` is the one ffmpeg demuxer allowed to read it.
 */
export interface AudioContainer {
  format: "flac" | "mp3" | "m4a" | "mpeg" | "ogg" | "wav" | "webm" | "aac";
  demuxer: "flac" | "mp3" | "mov" | "mpeg" | "ogg" | "wav" | "matroska" | "aac";
}

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  bytes.length >= start + text.length &&
  [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));

/** First packet of an Ogg logical stream for the audio codecs Ogg carries. */
const OGG_AUDIO_HEADS = ["OpusHead", "\x01vorbis", "\x7fFLAC", "Speex   "];

/** Ogg: capture pattern, version 0, a beginning-of-stream page whose first packet is audio. */
function isOggAudio(bytes: Uint8Array): boolean {
  if (!ascii(bytes, 0, "OggS") || bytes[4] !== 0 || (bytes[5] & 0x02) === 0) return false;
  const segments = bytes[26];
  if (segments === undefined || segments === 0) return false;
  const packetStart = 27 + segments;
  return OGG_AUDIO_HEADS.some((head) => ascii(bytes, packetStart, head));
}

/** Matroska/WebM: EBML magic, then a DocType element (0x4282) naming webm or matroska. */
function isMatroska(bytes: Uint8Array): boolean {
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    return false;
  }
  const end = Math.min(bytes.length - 2, 64);
  for (let i = 4; i < end; i++) {
    if (bytes[i] !== 0x42 || bytes[i + 1] !== 0x82) continue;
    // One-byte EBML size: 0x80 | length.
    const size = bytes[i + 2] & 0x7f;
    if ((bytes[i + 2] & 0x80) === 0) return false;
    return (
      (size === 4 && ascii(bytes, i + 3, "webm")) || (size === 8 && ascii(bytes, i + 3, "matroska"))
    );
  }
  return false;
}

/** ISO BMFF major brands of audio and video files (m4a, mp4, 3gp, QuickTime, DASH). */
const MP4_BRANDS = new Set([
  "M4A ",
  "M4B ",
  "M4V ",
  "mp41",
  "mp42",
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "avc1",
  "dash",
  "3gp4",
  "3gp5",
  "3gp6",
  "3g2a",
  "qt  ",
  "MSNV",
  "f4v ",
  "f4a ",
  "mp71",
]);

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

/**
 * Boxes one sniff may parse, across every level of the walk, so a forged upload made of
 * millions of tiny boxes or tracks costs no more than a short loop on the request thread. A
 * fragmented MP4 has one moof/mdat pair per fragment at the top level; everything else is a
 * handful of boxes.
 */
const MAX_MP4_BOXES_PER_UPLOAD = 100_000;

/** Shared countdown of boxes the current sniff may still parse. */
interface Mp4Budget {
  left: number;
}

interface Mp4Box {
  type: string;
  /** Payload range, after the box header. */
  start: number;
  end: number;
}

/**
 * The boxes in `[from, to)`, or null unless they chain exactly to `to`: a box that overruns its
 * parent, or bytes left over, mean a truncated or forged file. Size 1 is a 64-bit largesize;
 * size 0 (to the end of the parent) is only valid for the last box.
 */
function mp4Children(
  bytes: Uint8Array,
  from: number,
  to: number,
  budget: Mp4Budget
): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let at = from;
  while (at < to) {
    if (budget.left-- <= 0) return null;
    if (at + 8 > to) return null;
    let size = u32(bytes, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      size = u32(bytes, at + 8) * 2 ** 32 + u32(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) return null;
    boxes.push({
      type: String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]),
      start: at + header,
      end: at + size,
    });
    at += size;
  }
  return boxes;
}

/** True when a `trak` box holds `mdia/hdlr` with a sound or video handler. */
function isMediaTrack(bytes: Uint8Array, trak: Mp4Box, budget: Mp4Budget): boolean {
  for (const mdia of mp4Children(bytes, trak.start, trak.end, budget) ?? []) {
    if (mdia.type !== "mdia") continue;
    for (const box of mp4Children(bytes, mdia.start, mdia.end, budget) ?? []) {
      // hdlr payload: version/flags (4), pre_defined (4), handler_type (4).
      if (box.type !== "hdlr" || box.end - box.start < 12) continue;
      if (ascii(bytes, box.start + 8, "soun") || ascii(bytes, box.start + 8, "vide")) return true;
    }
  }
  return false;
}

/**
 * MP4: an `ftyp` box first with an audio/video major brand, top-level boxes that chain exactly to
 * the end of the upload (a truncated or padded file fails), a non-empty `mdat`, and a `moov` box
 * with a track whose `mdia/hdlr` handler is sound or video.
 */
function isMp4(bytes: Uint8Array): boolean {
  const budget: Mp4Budget = { left: MAX_MP4_BOXES_PER_UPLOAD };
  const top = mp4Children(bytes, 0, bytes.length, budget);
  if (!top || top[0]?.type !== "ftyp" || top[0].end - top[0].start < 8) return false;
  const brand = String.fromCharCode(...bytes.subarray(top[0].start, top[0].start + 4));
  if (!MP4_BRANDS.has(brand)) return false;
  const moov = top.find((box) => box.type === "moov");
  // Sample data lives in mdat (one per fragment in a fragmented file); a file without any has
  // nothing to decode.
  if (!moov || !top.some((box) => box.type === "mdat" && box.end > box.start)) return false;
  const tracks = mp4Children(bytes, moov.start, moov.end, budget);
  return !!tracks && tracks.some((box) => box.type === "trak" && isMediaTrack(bytes, box, budget));
}

/**
 * ADTS AAC: sync word with layer 00, a defined sample-rate index, a frame length that holds
 * its own header, and the next frame's sync word where the buffer reaches it.
 */
function isAdts(bytes: Uint8Array): boolean {
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf6) !== 0xf0) return false;
  if (((bytes[2] >> 2) & 0x0f) > 12) return false;
  const frameLength = ((bytes[3] & 0x03) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
  const headerLength = (bytes[1] & 0x01) === 1 ? 7 : 9;
  if (frameLength <= headerLength) return false;
  if (bytes.length >= frameLength + 2) {
    return bytes[frameLength] === 0xff && (bytes[frameLength + 1] & 0xf6) === 0xf0;
  }
  return true;
}

/** MPEG program stream: pack start code and the MPEG-1 or MPEG-2 pack header marker bits. */
function isMpegProgramStream(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (!(bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba)) {
    return false;
  }
  if ((bytes[4] & 0xc4) === 0x44) return (bytes[6] & 0x04) === 0x04 && (bytes[8] & 0x04) === 0x04;
  if ((bytes[4] & 0xf1) === 0x21) return (bytes[6] & 0x01) === 0x01 && (bytes[8] & 0x01) === 0x01;
  return false;
}

/**
 * The container of an upload, from its own bytes; null when they match none of the formats the
 * OpenAI transcription API lists (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm) or ADTS AAC.
 * The file name and MIME type are client claims and never trusted.
 *
 * The containers an upstream may not take, and that can therefore reach ffmpeg (ogg, webm,
 * m4a, aac, mpeg), need a structurally valid header naming an audio or video stream. This
 * narrows Proxy's condition that ffmpeg only sees valid media; it does not enforce it. An MP4
 * with a sound handler and any mdat bytes passes, since sample tables are not checked. ffmpeg
 * still parses what passes, behind the forced demuxer and the limits below. Proxy chose
 * in-process ffmpeg (2026-11-25) after being told no pre-check proves a file valid.
 * WAV, MP3 and FLAC are forwarded as they are, never converted, so a light check suffices.
 */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (isOggAudio(bytes)) return { format: "ogg", demuxer: "ogg" };
  if (isMatroska(bytes)) return { format: "webm", demuxer: "matroska" };
  if (isMp4(bytes)) return { format: "m4a", demuxer: "mov" };
  if (isMpegProgramStream(bytes)) return { format: "mpeg", demuxer: "mpeg" };
  if (isAdts(bytes)) return { format: "aac", demuxer: "aac" };
  if (ascii(bytes, 0, "fLaC")) return { format: "flac", demuxer: "flac" };
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return { format: "wav", demuxer: "wav" };
  if (ascii(bytes, 0, "ID3")) return { format: "mp3", demuxer: "mp3" };
  // MPEG audio frame sync with a layer (01-11) and a bitrate index other than "bad".
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    ((bytes[1] >> 1) & 0x03) !== 0 &&
    bytes[2] >> 4 !== 0x0f
  ) {
    return { format: "mp3", demuxer: "mp3" };
  }
  return null;
}

export type AudioTranscodeErrorCode =
  "aborted" | "busy" | "ffmpeg_missing" | "decode_failed" | "timeout" | "output_too_large";

export class AudioTranscodeError extends Error {
  constructor(
    readonly code: AudioTranscodeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AudioTranscodeError";
  }
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "ignore", "pipe"]; shell: false; windowsHide: true }
) => {
  stderr: NodeJS.ReadableStream | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
};

export interface TranscodeOptions {
  /** The upload's container from sniffAudioContainer; ffmpeg may use only its demuxer. */
  container: AudioContainer;
  maxOutputBytes: number;
  timeoutMs?: number;
  /** ffmpeg binary; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** The client request's signal: a waiting conversion leaves the queue, a running one is killed. */
  signal?: AbortSignal;
  maxQueueWaitMs?: number;
  /** Test hook. */
  spawnImpl?: SpawnLike;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_TAIL_BYTES = 2048;

/**
 * Every demuxer sniffAudioContainer can name (`mov` is ffmpeg's `mov,mp4,m4a,3gp,3g2,mj2`,
 * `matroska` its `matroska,webm`, `mpeg` the MPEG program stream). A conversion forces the one
 * its upload sniffed as, so ffmpeg never probes. Playlist and reference formats (hls, concat,
 * ffconcat, image2, tee, ...) are never allowed: they open other files or URLs named inside an
 * untrusted upload.
 */
export const ALLOWED_INPUT_DEMUXERS = [
  "ogg",
  "matroska",
  "mov",
  "wav",
  "mp3",
  "flac",
  "aac",
  "mpeg",
];

/**
 * The ffmpeg arguments. The input is confined to the local `file` protocol and read by the one
 * forced demuxer; the output drops any video stream, downmixes to mono, resamples to 16 kHz, FLAC.
 */
export function buildFlacTranscodeArgs(
  inputPath: string,
  outputPath: string,
  maxOutputBytes: number,
  demuxer: string
): string[] {
  if (!ALLOWED_INPUT_DEMUXERS.includes(demuxer)) {
    throw new AudioTranscodeError("decode_failed", "Audio container is not supported");
  }
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    demuxer,
    "-f",
    demuxer,
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    // ffmpeg stops writing once the file passes this size (it may finish one more packet),
    // so a long upload cannot fill the temp disk before the size check below.
    "-fs",
    String(maxOutputBytes + 1),
    "-f",
    "flac",
    outputPath,
  ];
}

/** Conversions running at once; each holds an upload and its FLAC in memory and on disk. */
export const MAX_CONCURRENT_TRANSCODES = 2;
/** Conversions allowed to wait for a slot. Each waiter still holds its upload in memory, so a
 * burst beyond this is refused (`busy`) instead of queueing without bound. */
export const MAX_QUEUED_TRANSCODES = 4;
/** Longest a conversion waits for a slot before it is refused as `busy`. */
export const DEFAULT_QUEUE_WAIT_MS = 60 * 1000;

interface Waiter {
  grant: () => void;
}
let activeTranscodes = 0;
const waitingTranscodes: Waiter[] = [];

function abortedError(): AudioTranscodeError {
  return new AudioTranscodeError("aborted", "The client closed the request");
}

/** Wait for a free slot. A waiter leaves the queue on abort or after `maxWaitMs`. */
function acquireTranscodeSlot(signal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  if (activeTranscodes < MAX_CONCURRENT_TRANSCODES) {
    activeTranscodes++;
    return Promise.resolve();
  }
  if (waitingTranscodes.length >= MAX_QUEUED_TRANSCODES) {
    return Promise.reject(
      new AudioTranscodeError("busy", "Too many audio conversions in progress; retry shortly")
    );
  }
  return new Promise<void>((resolve, reject) => {
    const leave = (error: AudioTranscodeError) => {
      const index = waitingTranscodes.indexOf(waiter);
      if (index < 0) return; // already granted
      waitingTranscodes.splice(index, 1);
      cleanup();
      reject(error);
    };
    const onAbort = () => leave(abortedError());
    const timer = setTimeout(
      () => leave(new AudioTranscodeError("busy", "Audio conversion queue is full; retry shortly")),
      maxWaitMs
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const waiter: Waiter = {
      // The releasing conversion hands its slot over; activeTranscodes stays the same.
      grant: () => {
        cleanup();
        resolve();
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waitingTranscodes.push(waiter);
  });
}

function releaseTranscodeSlot(): void {
  const next = waitingTranscodes.shift();
  if (next) next.grant();
  else activeTranscodes--;
}

/**
 * Convert an audio upload to 16 kHz mono FLAC. Throws AudioTranscodeError; its message is safe
 * to return to the client (no paths, no ffmpeg output).
 */
export async function transcodeToFlac(
  input: AudioBytes,
  options: TranscodeOptions
): Promise<AudioBytes> {
  await acquireTranscodeSlot(options.signal, options.maxQueueWaitMs ?? DEFAULT_QUEUE_WAIT_MS);
  try {
    return await transcodeNow(input, options);
  } finally {
    releaseTranscodeSlot();
  }
}

async function transcodeNow(input: AudioBytes, options: TranscodeOptions): Promise<AudioBytes> {
  const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), "omniroute-stt-"));
  const inputPath = join(dir, `input.${options.container.format}`);
  const outputPath = join(dir, "output.flac");
  try {
    await writeFile(inputPath, input, { mode: 0o600 });
    await runFfmpeg(
      spawnImpl,
      options.ffmpegPath || "ffmpeg",
      buildFlacTranscodeArgs(
        inputPath,
        outputPath,
        options.maxOutputBytes,
        options.container.demuxer
      ),
      timeoutMs,
      options.signal
    );
    const size = (await stat(outputPath)).size;
    if (size > options.maxOutputBytes) {
      throw new AudioTranscodeError(
        "output_too_large",
        `Converted audio is ${size} bytes, above the upstream limit of ${options.maxOutputBytes} bytes`
      );
    }
    if (size === 0) {
      throw new AudioTranscodeError("decode_failed", "Audio could not be decoded");
    }
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      console.error("[STT] Failed to remove a transcode temp directory");
    });
  }
}

function runFfmpeg(
  spawnImpl: SpawnLike,
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stderrTail = "";
    let settled = false;
    const finish = (error: AudioTranscodeError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AudioTranscodeError("timeout", "Audio conversion timed out"));
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => {
      finish(
        error.code === "ENOENT"
          ? new AudioTranscodeError(
              "ffmpeg_missing",
              "ffmpeg is not installed on this server, so this audio format cannot be converted"
            )
          : new AudioTranscodeError("decode_failed", "Audio conversion could not start")
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) return finish(null);
      // ffmpeg's own message names the codec problem; keep it in the server log only.
      console.warn("[STT] ffmpeg failed", { code, signal, stderr: stderrTail.trim() });
      finish(new AudioTranscodeError("decode_failed", "Audio could not be decoded"));
    });
  });
}
