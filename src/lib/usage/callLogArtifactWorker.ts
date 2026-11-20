import { parentPort } from "node:worker_threads";

import {
  buildArtifactRelativePath,
  reserializeArtifactWithId,
  serializeArtifactForStorage,
  writeCallArtifact,
  writeSerializedCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";

type WriteEnvironment = {
  pipelineMaxSizeKb?: string;
  chatDebugFile?: string;
  appLogLevel?: string;
  dataDir?: string;
};

/** Serialize and write at once (no `kind`): the path used when log batching is off. */
type WriteRequest = {
  kind?: undefined;
  id: number;
  artifact: CallLogArtifact;
  environment: WriteEnvironment;
};

/** Serialize now and hold the string until its row is committed (log batching, fix 3). */
type SerializeRequest = {
  kind: "serialize";
  id: number;
  key: number;
  artifact: CallLogArtifact;
  environment: WriteEnvironment;
};

/**
 * Write held strings; `rowId` is set when the row's id changed on an id collision. Each entry
 * is written under the environment it was serialized with (data dir, debug formatting, size
 * budget), not the one current at write time.
 */
type WriteHeldRequest = {
  kind: "write";
  id: number;
  entries: Array<{ key: number; rowId?: string }>;
};

type ReleaseRequest = { kind: "release"; id: number; keys: number[] };

type Request = WriteRequest | SerializeRequest | WriteHeldRequest | ReleaseRequest;

type HeldArtifact = {
  serialized: string;
  timestamp: string;
  id: string;
  environment: WriteEnvironment;
};

const held = new Map<number, HeldArtifact>();

function applyWriteEnvironment(environment: WriteEnvironment): void {
  const values = {
    CALL_LOG_PIPELINE_MAX_SIZE_KB: environment.pipelineMaxSizeKb,
    CHAT_DEBUG_FILE: environment.chatDebugFile,
    APP_LOG_LEVEL: environment.appLogLevel,
    // The worker resolves its paths lazily like the parent; pin it to the
    // parent's resolved dir so both executors share one target.
    DATA_DIR: environment.dataDir,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function writeHeld(entry: { key: number; rowId?: string }): CallLogArtifactWriteResult | null {
  const artifact = held.get(entry.key);
  // An unknown key (a fresh worker after a crash, or a released entry) ends that row missing;
  // it never fails the other entries of the job.
  if (!artifact) return null;
  held.delete(entry.key);
  applyWriteEnvironment(artifact.environment);
  const id = entry.rowId ?? artifact.id;
  const serialized =
    id === artifact.id ? artifact.serialized : reserializeArtifactWithId(artifact.serialized, id);
  // The path comes from the final id, so a collision never overwrites another row's file (#14451).
  return writeSerializedCallArtifact(serialized, buildArtifactRelativePath(artifact.timestamp, id));
}

function handle(request: Request): unknown {
  switch (request.kind) {
    case "serialize": {
      applyWriteEnvironment(request.environment);
      const serialized = serializeArtifactForStorage(request.artifact);
      held.set(request.key, {
        serialized,
        timestamp: request.artifact.summary.timestamp,
        id: request.artifact.summary.id,
        environment: request.environment,
      });
      return { sizeBytes: Buffer.byteLength(serialized) };
    }
    case "write": {
      return {
        results: request.entries.map((entry) => {
          try {
            return writeHeld(entry);
          } catch {
            return null;
          }
        }),
      };
    }
    case "release":
      for (const key of request.keys) held.delete(key);
      return {};
    default:
      // The writer reads these options lazily; mirror the caller's per-write environment snapshot.
      applyWriteEnvironment(request.environment);
      return { result: writeCallArtifact(request.artifact) };
  }
}

function failureReply(request: Request): unknown {
  if (request.kind === "serialize") return { sizeBytes: null };
  if (request.kind === "write") return { results: request.entries.map(() => null) };
  if (request.kind === "release") return {};
  return { result: null };
}

parentPort?.on("message", (request: Request) => {
  const originalConsoleError = console.error;
  let reply: unknown;

  try {
    // writeCallArtifact's legacy error includes filesystem paths. Keep worker failures generic.
    console.error = () => {};
    reply = handle(request);
  } catch {
    reply = failureReply(request);
  } finally {
    console.error = originalConsoleError;
  }

  try {
    parentPort?.postMessage({ id: request.id, ...(reply as object) });
  } catch {
    parentPort?.postMessage({ id: request.id, ...(failureReply(request) as object) });
  }
});
