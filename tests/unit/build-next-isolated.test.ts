import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getTransientBuildPaths,
  movePath,
  pruneStandaloneArtifacts,
  resolveBuildHeapMb,
  resolveBuildWorkerTotal,
  resolveNextBuildEnv,
  shouldBuildStandalone,
  syncStandaloneExtraModules,
  syncStandaloneNativeAssets,
} from "../../scripts/build/build-next-isolated.mjs";

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omniroute-build-next-isolated-"));

  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("movePath falls back to copy/remove when rename raises EXDEV", async () => {
  await withTempDir(async (tempDir) => {
    const sourceDir = path.join(tempDir, "app");
    const destinationDir = path.join(tempDir, ".app-build-backup");
    const nestedFile = path.join(sourceDir, "nested", "file.txt");

    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, "legacy payload");

    let copyCalled = false;
    let removeCalled = false;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));

    try {
      await movePath(sourceDir, destinationDir, {
        rename: async () => {
          const error = new Error("cross-device link not permitted");
          error.code = "EXDEV";
          throw error;
        },
        cp: async (...args) => {
          copyCalled = true;
          return fs.cp(...args);
        },
        rm: async (...args) => {
          removeCalled = true;
          return fs.rm(...args);
        },
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(copyCalled, true);
    assert.equal(removeCalled, true);
    assert.equal(fsSync.existsSync(sourceDir), false);
    assert.equal(
      await fs.readFile(path.join(destinationDir, "nested", "file.txt"), "utf8"),
      "legacy payload"
    );
    assert.match(warnings[0] ?? "", /EXDEV while moving/);
  });
});

test("movePath rethrows non-EXDEV rename failures", async () => {
  await withTempDir(async (tempDir) => {
    const sourceDir = path.join(tempDir, "app");
    const destinationDir = path.join(tempDir, ".app-build-backup");

    await fs.mkdir(sourceDir, { recursive: true });

    await assert.rejects(
      movePath(sourceDir, destinationDir, {
        rename: async () => {
          const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
          throw error;
        },
        cp: async () => {
          throw new Error("copy fallback should not run");
        },
        rm: async () => {
          throw new Error("remove fallback should not run");
        },
      }),
      (error) => error instanceof Error && "code" in error && error.code === "EACCES"
    );
  });
});

test("resolveNextBuildEnv forces stable build worker mode unless already provided", () => {
  const defaultEnv = resolveNextBuildEnv({ NODE_ENV: "test" });
  assert.equal(defaultEnv.NEXT_PRIVATE_BUILD_WORKER, "0");
  assert.equal(defaultEnv.NODE_ENV, "test");

  const preservedEnv = resolveNextBuildEnv({
    NODE_ENV: "production",
    NEXT_PRIVATE_BUILD_WORKER: "1",
  });
  assert.equal(preservedEnv.NEXT_PRIVATE_BUILD_WORKER, "1");
  assert.equal(preservedEnv.NODE_ENV, "production");
});

// Escalated bug (WhatsApp BR, cmqiuhd7600): a local `npm run build` stalls/OOMs
// during the webpack production pass ("Compiling instrumentation" bundles the whole
// server graph). #4076/#4104 raised the heap only in the Docker builder stage; the
// local/native path (build-next-isolated.mjs → resolveNextBuildEnv) was left on V8's
// default ~2 GB ceiling, so memory-constrained npm-global installs hit the same OOM.
test("resolveNextBuildEnv raises the Node heap for memory-constrained local builds", () => {
  const env = resolveNextBuildEnv({ NODE_ENV: "production" });
  const match = (env.NODE_OPTIONS ?? "").match(/--max-old-space-size=(\d+)/);
  assert.ok(
    match,
    "local build must set NODE_OPTIONS --max-old-space-size to avoid the webpack-pass OOM"
  );
  assert.ok(
    Number(match[1]) >= 4096,
    `build heap default must be >= 4096 MB (the V8 default ~2 GB OOMed); got ${match[1]}`
  );
});

test("resolveNextBuildEnv does not clobber an existing --max-old-space-size (Docker)", () => {
  const env = resolveNextBuildEnv({ NODE_OPTIONS: "--max-old-space-size=8192" });
  const occurrences = (env.NODE_OPTIONS.match(/--max-old-space-size=/g) || []).length;
  assert.equal(occurrences, 1, "must not duplicate the heap flag when one is already set");
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=8192/);
});

test("resolveNextBuildEnv honors the OMNIROUTE_BUILD_MEMORY_MB override", () => {
  const env = resolveNextBuildEnv({ OMNIROUTE_BUILD_MEMORY_MB: "6144" });
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=6144/);
});

const GiB = 1024 ** 3;

// Next 16 forks `cpus - 1` page-data workers (or CIRCLE_NODE_TOTAL - 1) regardless of RAM;
// each one can peak at ~4.5 GB RSS (#7518). Only the Dockerfile capped the pool, so a
// local `npm run build` on a 12-core / 16 GB desktop forked 11 workers and swapped.
test("resolveBuildWorkerTotal caps the page-data pool by RAM, not just cores", () => {
  // 16 GiB, 12 cores: 0.75 * 16384 / 4500 = 2 processes -> 1 worker (+1 parent).
  assert.equal(resolveBuildWorkerTotal({}, 16 * GiB, 12), 2);
  // 64 GiB, 12 cores: 10 processes -> 9 workers.
  assert.equal(resolveBuildWorkerTotal({}, 64 * GiB, 12), 10);
  // 64 GiB, 4 cores: core-bound at cpus - 1 = 3 workers.
  assert.equal(resolveBuildWorkerTotal({}, 64 * GiB, 4), 4);
  // Tiny host still gets one worker; unknown RAM falls back to one worker.
  assert.equal(resolveBuildWorkerTotal({}, 4 * GiB, 8), 2);
  assert.equal(resolveBuildWorkerTotal({}, null, 8), 2);
});

test("resolveBuildWorkerTotal keeps explicit operator choices", () => {
  assert.equal(resolveBuildWorkerTotal({ CIRCLE_NODE_TOTAL: "8" }, 16 * GiB, 12), null);
  assert.equal(resolveBuildWorkerTotal({ OMNIROUTE_BUILD_WORKERS: "6" }, 16 * GiB, 12), 7);
});

test("resolveNextBuildEnv wires the worker cap into CIRCLE_NODE_TOTAL", () => {
  const env = resolveNextBuildEnv({}, "linux", { memoryBytes: 16 * GiB, cpuCount: 12 });
  assert.equal(env.CIRCLE_NODE_TOTAL, "2");
  const preserved = resolveNextBuildEnv({ CIRCLE_NODE_TOTAL: "5" }, "linux", {
    memoryBytes: 16 * GiB,
    cpuCount: 12,
  });
  assert.equal(preserved.CIRCLE_NODE_TOTAL, "5");
});

test("resolveBuildHeapMb scales the default heap with RAM inside [4096, 8192]", () => {
  assert.equal(resolveBuildHeapMb(4 * GiB), 4096);
  assert.equal(resolveBuildHeapMb(8 * GiB), 4915);
  assert.equal(resolveBuildHeapMb(32 * GiB), 8192);
  assert.equal(resolveBuildHeapMb(null), 8192);
  const env = resolveNextBuildEnv({}, "linux", { memoryBytes: 8 * GiB, cpuCount: 4 });
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=4915/);
});

test("getTransientBuildPaths leaves _tasks in place by default", () => {
  const paths = getTransientBuildPaths("/repo", {});

  // Layer 1 deleted the root-level `app/` move-out hack, so the only default
  // transient path left is the Wine prefix. ("legacy app snapshot" is gone.)
  assert.deepEqual(
    paths.map((entry) => entry.label),
    ["local Wine prefix"]
  );
  assert.equal(
    paths.some((entry) => path.basename(entry.sourcePath) === "_tasks"),
    false
  );
});

test("getTransientBuildPaths only moves _tasks when explicitly enabled", () => {
  const paths = getTransientBuildPaths("/repo", { OMNIROUTE_BUILD_MOVE_TASKS: "1" });

  assert.equal(
    paths.some((entry) => path.basename(entry.sourcePath) === "_tasks"),
    true
  );
});

test("pruneStandaloneArtifacts removes traced _tasks from standalone output", async () => {
  await withTempDir(async (tempDir) => {
    // Layer 1 moved the Next distDir default to .build/next.
    const tracedTaskFile = path.join(tempDir, ".build", "next", "standalone", "_tasks", "plan.md");
    await fs.mkdir(path.dirname(tracedTaskFile), { recursive: true });
    await fs.writeFile(tracedTaskFile, "transient planning artifact");

    await pruneStandaloneArtifacts(tempDir);

    assert.equal(
      fsSync.existsSync(path.join(tempDir, ".build", "next", "standalone", "_tasks")),
      false
    );
  });
});

test("syncStandaloneExtraModules copies the complete wreq-js runtime", async () => {
  await withTempDir(async (tempDir) => {
    const sourcePackage = path.join(tempDir, "node_modules", "wreq-js");
    const destinationPackage = path.join(
      tempDir,
      ".build",
      "next",
      "standalone",
      "node_modules",
      "wreq-js"
    );
    const logs: string[] = [];
    const logger: Console = Object.assign(Object.create(console), {
      log: (message: unknown) => logs.push(String(message)),
    });

    await fs.mkdir(path.join(sourcePackage, "dist"), { recursive: true });
    await fs.mkdir(path.join(sourcePackage, "rust"), { recursive: true });
    await fs.writeFile(path.join(sourcePackage, "package.json"), '{"name":"wreq-js"}');
    await fs.writeFile(path.join(sourcePackage, "dist", "wreq-js.cjs"), "exports.fetch = () => {}");
    await fs.writeFile(
      path.join(sourcePackage, "rust", "wreq-js.linux-x64-gnu.node"),
      "native module bytes"
    );

    const changed = await syncStandaloneExtraModules(tempDir, fs, logger);

    assert.equal(changed, true);
    assert.equal(
      await fs.readFile(path.join(destinationPackage, "package.json"), "utf8"),
      '{"name":"wreq-js"}'
    );
    assert.equal(
      await fs.readFile(path.join(destinationPackage, "dist", "wreq-js.cjs"), "utf8"),
      "exports.fetch = () => {}"
    );
    assert.equal(
      await fs.readFile(
        path.join(destinationPackage, "rust", "wreq-js.linux-x64-gnu.node"),
        "utf8"
      ),
      "native module bytes"
    );
    assert.match(logs[0] ?? "", /wreq-js TLS runtime/);
  });
});

test("shouldBuildStandalone honors OMNIROUTE_SKIP_STANDALONE and contributor profile", () => {
  assert.equal(shouldBuildStandalone({}), true);
  assert.equal(shouldBuildStandalone({ OMNIROUTE_SKIP_STANDALONE: "0" }), true);
  assert.equal(shouldBuildStandalone({ OMNIROUTE_SKIP_STANDALONE: "1" }), false);
  assert.equal(shouldBuildStandalone({ OMNIROUTE_BUILD_PROFILE: "contributor" }), false);
  assert.equal(
    shouldBuildStandalone({
      OMNIROUTE_SKIP_STANDALONE: "1",
      OMNIROUTE_BUILD_PROFILE: "minimal",
    }),
    false
  );
  assert.equal(shouldBuildStandalone({ OMNIROUTE_BUILD_PROFILE: "minimal" }), true);
});
