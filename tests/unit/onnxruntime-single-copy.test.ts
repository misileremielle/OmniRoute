/**
 * Regression guard — the dependency tree must resolve exactly ONE
 * `onnxruntime-node` (and one `onnxruntime-common`).
 *
 * `@huggingface/transformers` pins `onnxruntime-node` to an EXACT version
 * (4.3.0 → "1.30.0"). Whenever the root range in package.json drifts off that
 * pin, a second copy is installed for @huggingface/transformers.
 *
 * Two copies cannot coexist in one Node process: both ship a native
 * `libonnxruntime.so.1` under the SAME SONAME, so glibc's loader binds
 * whichever was dlopen()ed first and the other addon dies with
 *
 *   Error: .../libonnxruntime.so.1: version `VERS_1.27.0' not found
 *          (required by .../onnxruntime_binding.node)
 *
 * That is exactly what a production-group dependabot bump did on 2026-08-16
 * (root `onnxruntime-node` "~1.24.3" → "~1.27.0"): it broke the Docker image
 * build at the Dockerfile's post-build standalone verification step, which
 * imports `@huggingface/transformers` and `onnxruntime-node` in one process.
 *
 * Keep the root range compatible with whatever `@huggingface/transformers`
 * pins — do not "fix" a future recurrence by copying the nested native
 * binaries into the bundle; the SONAME clash makes that impossible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  importerDependency,
  lockedVersions,
  packageSnapshots,
  readPnpmLock,
  stripPeerSuffix,
} from "../../scripts/ci/pnpmLock.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const lockfile = readPnpmLock(repoRoot);

// Scoped to `onnxruntime-node` on purpose. `onnxruntime-common` is types/interfaces
// only and `onnxruntime-web` is WASM — neither dlopen()s anything, so their nested
// duplicates (onnxruntime-web carries its own onnxruntime-common) are harmless.
// `onnxruntime-node` is the sole package shipping the native libonnxruntime.so.1.
test("pnpm-lock.yaml resolves exactly one copy of onnxruntime-node", () => {
  assert.equal(
    lockedVersions(lockfile, "onnxruntime-node").length,
    1,
    "onnxruntime-node must resolve to a single copy — a duplicate ships a second " +
      "libonnxruntime.so.1 under the same SONAME and breaks the standalone/Docker build"
  );
});

test("root onnxruntime-node matches the version @huggingface/transformers resolves", () => {
  const transformers = packageSnapshots(lockfile, "@huggingface/transformers");
  assert.ok(transformers.length > 0, "@huggingface/transformers must be present in the lockfile");

  const resolved = importerDependency(lockfile, "onnxruntime-node")?.version;
  for (const [, snapshot] of transformers) {
    const pinned = snapshot.dependencies?.["onnxruntime-node"];
    assert.ok(pinned, "@huggingface/transformers must declare an onnxruntime-node dependency");
    assert.equal(
      resolved,
      stripPeerSuffix(pinned),
      `the root onnxruntime-node (${resolved}) must equal the version ` +
        `@huggingface/transformers resolves (${pinned}); otherwise a second, ` +
        `ABI-incompatible native copy is installed`
    );
  }
});
