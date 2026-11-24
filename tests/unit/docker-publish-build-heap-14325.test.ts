// Regression coverage for #14325 — the `:next` Docker channel got stuck at the
// 2026-09-17 image because every `docker/build-push-action` step in
// docker-publish.yml runs `npm run build` (webpack, OMNIROUTE_USE_TURBOPACK=0)
// with the Dockerfile's default 6144 MB V8 heap ceiling
// (`ARG OMNIROUTE_BUILD_MEMORY_MB=6144`), instead of the 12288 MB ceiling that
// the equivalent native `npm run build` invocations already use in
// build.yml/quality.yml on the very same runner class. The build then dies with
// "FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript heap
// out of memory" during the webpack production pass, well before the process's
// RSS would approach the kernel/cgroup OOM-killer limit that
// docker-build-memory-budget.test.ts already guards.
//
// This is a distinct failure mode from that file's "ResourceExhausted" kernel
// OOM: this one is V8 hitting its OWN heap ceiling, which is a pure function of
// the --max-old-space-size value baked into NODE_OPTIONS at build time. Under
// webpack (unlike Turbopack) that ceiling directly bounds the process's real
// memory use, so it is fixable by raising the heap budget alone.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/docker-publish.yml", import.meta.url)),
  "utf8"
);

// The hosted runner's native webpack build fit 10240 MB (run 39151150605, build.yml, which the
// fork has since removed). That measurement stays the floor for the Docker heap below.
const NATIVE_WEBPACK_FLOOR_MB = 10240;

test("every docker-publish.yml build-push-action step raises the V8 heap ceiling past the Dockerfile's 6144 MB default", () => {
  const buildArgBlocks = [...workflow.matchAll(/build-args:\s*\|\n((?: {12}\S.*\n)+)/g)].map(
    (m) => m[1]
  );

  assert.ok(
    buildArgBlocks.length >= 2,
    `expected at least 2 build-args blocks (runner-base and runner-web), found ${buildArgBlocks.length}`
  );

  const missing: number[] = [];
  buildArgBlocks.forEach((block, i) => {
    if (!/OMNIROUTE_BUILD_MEMORY_MB=\d+/.test(block)) {
      missing.push(i);
    }
  });

  assert.deepEqual(
    missing,
    [],
    `build-args block(s) at index ${JSON.stringify(missing)} never override OMNIROUTE_BUILD_MEMORY_MB, ` +
      `so those docker/build-push-action steps build with the Dockerfile's default ` +
      `ARG OMNIROUTE_BUILD_MEMORY_MB=6144 heap ceiling instead of a budget the hosted runner class is ` +
      `known to fit (the native floor) — this is why every Docker publish on release/v3.8.51 since ` +
      `2026-09-18 16:58 UTC has died with "JavaScript heap out of memory" inside the webpack production pass`
  );
});

// Both values are measured, on purpose different: the native webpack build fits
// 10240 MB on the hosted runner (run 39151150605), and the same webpack build inside
// BuildKit publishes at 12288 MB (runs 38904652365, 38907575198, 39010473398). BuildKit
// adds overhead around the same build, so the Docker heap must never fall below the
// native floor.
test("every docker-publish.yml heap override is at or above the native webpack floor", () => {
  const floor = NATIVE_WEBPACK_FLOOR_MB;
  const dockerHeaps = [...workflow.matchAll(/OMNIROUTE_BUILD_MEMORY_MB=(\d+)/g)].map((m) =>
    Number(m[1])
  );
  assert.ok(
    dockerHeaps.length >= 2,
    `expected >= 2 docker heap overrides, found ${dockerHeaps.length}`
  );
  const below = dockerHeaps.filter((mb) => mb < floor);
  assert.deepEqual(below, [], `docker heap below the native floor of ${floor} MB`);
});
