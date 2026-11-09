import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = path.join(process.cwd(), "next.config.mjs");
const originalNextDistDir = process.env.NEXT_DIST_DIR;

async function loadNextConfig(label) {
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
}

test.afterEach(() => {
  if (originalNextDistDir === undefined) {
    delete process.env.NEXT_DIST_DIR;
  } else {
    process.env.NEXT_DIST_DIR = originalNextDistDir;
  }
});

test("next config exposes standalone build settings and canonical rewrites", async () => {
  process.env.NEXT_DIST_DIR = ".next-task607";
  const { default: nextConfig } = await loadNextConfig("distdir");

  const rewrites = await nextConfig.rewrites();
  const headers = await nextConfig.headers();
  const securityHeaders = Object.fromEntries(
    headers[0].headers.map(({ key, value }) => [key, value])
  );

  assert.equal(nextConfig.distDir, ".next-task607");
  assert.equal(nextConfig.output, "standalone");
  // #67 / #11783: React Compiler is an explicit Next 16 opt-in (peer babel plugin).
  assert.equal(nextConfig.reactCompiler, true);
  assert.equal(nextConfig.images.unoptimized, true);
  assert.deepEqual(nextConfig.transpilePackages, [
    "@omniroute/open-sse",
    "@lobehub/icons",
    "@omniroute/ui-kit",
  ]);
  // #6062: `ws` and its native masking helpers must stay external so the
  // copilot-m365-web executor keeps a working WebSocket masking path at runtime
  // (bundling ws breaks `bufferutil` → `TypeError: b.mask is not a function`).
  for (const pkg of ["ws", "bufferutil", "utf-8-validate"]) {
    assert.ok(
      nextConfig.serverExternalPackages.includes(pkg),
      `expected serverExternalPackages to externalize "${pkg}" (#6062)`
    );
  }
  assert.equal(headers[0].source, "/:path*");
  assert.match(securityHeaders["Content-Security-Policy"], /default-src 'self'/);
  assert.match(securityHeaders["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(securityHeaders["X-Frame-Options"], "DENY");
  assert.equal(securityHeaders["X-Content-Type-Options"], "nosniff");
  assert.match(securityHeaders["Strict-Transport-Security"], /includeSubDomains/);
  assert.deepEqual(rewrites.slice(0, 4), [
    {
      source: "/chat/completions",
      destination: "/api/v1/chat/completions",
    },
    {
      source: "/responses",
      destination: "/api/v1/responses",
    },
    {
      source: "/responses/:path*",
      destination: "/api/v1/responses/:path*",
    },
    {
      source: "/models",
      destination: "/api/v1/models",
    },
  ]);
});

test("next config declares Turbopack aliases, runtime assets and server externals", async () => {
  const { default: nextConfig } = await loadNextConfig("runtime-assets");
  const serverExternalPackages = new Set(nextConfig.serverExternalPackages);
  const tracingIncludes =
    nextConfig.outputFileTracingIncludes?.["/*"] ||
    nextConfig.outputFileTracingIncludes?.["**/*"] ||
    [];
  const tracingExcludes =
    nextConfig.outputFileTracingExcludes?.["**/*"] ||
    nextConfig.outputFileTracingExcludes?.["/*"] ||
    [];

  assert.equal(nextConfig.turbopack.root, process.cwd());
  // #11343: same story for the better-sqlite3 build stub. resolveAlias is applied
  // BEFORE the serverExternalPackages check, so an unconditional alias bundles the
  // stub and every route answers 500 at runtime ("r(...) is not a constructor").
  assert.equal(nextConfig.turbopack.resolveAlias["better-sqlite3"], undefined);
  assert.equal(nextConfig.outputFileTracingRoot, process.cwd());
  assert.ok(tracingIncludes.includes("./src/lib/db/migrations/**/*"));
  assert.ok(
    tracingIncludes.includes("./open-sse/services/compression/engines/rtk/filters/**/*.json")
  );
  assert.ok(tracingIncludes.includes("./open-sse/services/compression/rules/**/*.json"));
  // sql.js WASM must ship in the standalone bundle: sqljsAdapter resolves it from
  // node_modules/sql.js/dist/sql-wasm.wasm at runtime (driver fallback tier), but
  // Next traces sql-wasm.js without auto-including the runtime .wasm asset.
  assert.ok(
    tracingIncludes.includes("./node_modules/sql.js/dist/sql-wasm.wasm"),
    "sql-wasm.wasm must be trace-included so the sql.js fallback works in standalone builds"
  );
  assert.ok(
    tracingExcludes.some((p) => p.includes("_tasks")),
    "outputFileTracingExcludes should exclude _tasks"
  );
  assert.ok(
    tracingExcludes.some((p) => p.includes("tests")),
    "outputFileTracingExcludes should exclude tests"
  );
  assert.ok(
    tracingExcludes.some((p) => p.includes(".claude")),
    "outputFileTracingExcludes should exclude .claude worktrees"
  );

  for (const packageName of [
    "thread-stream",
    "better-sqlite3",
    "node-machine-id",
    "wreq-js",
    "fs",
    "path",
    "child_process",
    "crypto",
    "net",
    "tls",
  ]) {
    assert.ok(serverExternalPackages.has(packageName), `${packageName} should be externalized`);
  }
});

test("Turbopack aliases better-sqlite3 to the stub ONLY when OMNIROUTE_BETTER_SQLITE3_STUB=1 (#11343)", async () => {
  const original = process.env.OMNIROUTE_BETTER_SQLITE3_STUB;
  try {
    delete process.env.OMNIROUTE_BETTER_SQLITE3_STUB;
    const { default: def } = await loadNextConfig("bettersqlite-default");
    assert.equal(def.turbopack.resolveAlias["better-sqlite3"], undefined);
    // The default build must keep the real package reachable as an external, which
    // is exactly what the alias silently defeated.
    assert.ok(new Set(def.serverExternalPackages).has("better-sqlite3"));

    process.env.OMNIROUTE_BETTER_SQLITE3_STUB = "1";
    const { default: stubbed } = await loadNextConfig("bettersqlite-optin");
    assert.equal(
      stubbed.turbopack.resolveAlias["better-sqlite3"],
      "./src/lib/db/better-sqlite3.stub.js"
    );
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_BETTER_SQLITE3_STUB;
    else process.env.OMNIROUTE_BETTER_SQLITE3_STUB = original;
  }
});

test("next-intl webpack hook preserves caller config and filters known extractor warnings", async () => {
  const { default: nextConfig } = await loadNextConfig("webpack-pass-through");
  const infrastructureWarnings: unknown[][] = [];
  const infrastructureConsole = Object.create(console) as Console;
  infrastructureConsole.warn = (...args: unknown[]) => {
    infrastructureWarnings.push(args);
  };
  const config: any = {
    context: process.cwd(),
    infrastructureLogging: { console: infrastructureConsole },
    plugins: [],
    externals: [],
    ignoreWarnings: [],
    resolve: { fallback: { http: true } },
  };

  nextConfig.webpack(config, {
    isServer: false,
    defaultLoaders: { babel: {} } as any,
    webpack: {
      IgnorePlugin: class {
        options: any;

        constructor(options) {
          this.options = options;
        }
      },
    },
  });

  assert.deepEqual(config.plugins, []);
  assert.deepEqual(config.externals, []);
  assert.deepEqual(config.resolve.fallback, { http: true });
  assert.equal(config.ignoreWarnings.length, 1);
  assert.equal(
    config.ignoreWarnings[0]({
      message:
        "Parsing of /repo/node_modules/next-intl/dist/esm/production/extractor/format/index.js for build dependencies failed at 'import(t)'.",
      module: {
        resource: "/repo/node_modules/next-intl/dist/esm/production/extractor/format/index.js",
      },
    }),
    true
  );
  assert.equal(
    config.ignoreWarnings[0]({
      message:
        "Parsing of /repo/node_modules/next-intl/dist/esm/production/extractor/format/index.js for build dependencies failed at 'import(t)'.",
    }),
    false
  );
  assert.equal(
    config.ignoreWarnings[0]({
      message: "Critical dependency: the request of a dependency is an expression",
      module: {
        resource: "/repo/node_modules/next-intl/dist/esm/production/extractor/format/index.js",
      },
    }),
    true
  );
  assert.equal(
    config.ignoreWarnings[0]({ message: "Critical dependency: request is expression" }),
    false
  );
  config.infrastructureLogging.console.warn(
    "[webpack.cache.PackFileCacheStrategy/webpack.FileSystemInfo] Parsing of " +
      "/repo/node_modules/next-intl/dist/esm/production/extractor/format/index.js for build " +
      "dependencies failed at 'import(t)'.\nBuild dependencies behind this expression are ignored " +
      "and might cause incorrect cache invalidation."
  );
  assert.deepEqual(infrastructureWarnings, []);

  config.infrastructureLogging.console.warn("unrelated infrastructure warning");
  assert.deepEqual(infrastructureWarnings, [["unrelated infrastructure warning"]]);
});

test("turbopack.ignoreIssue suppresses the agentSkills over-bundling warning (#6582)", async () => {
  // src/lib/agentSkills/generator.ts joins process.cwd() with a runtime
  // `outputDir` parameter — not a compile-time literal — so Turbopack's
  // file-tracing analyzer can't narrow it and emits an "Overly broad
  // patterns..." warning per entry point importing the module. The fs access
  // is legitimate and bounded, so it's suppressed via turbopack.ignoreIssue
  // rather than fought. This guards the config shape so the suppression rule
  // isn't silently dropped in a future edit.
  const { default: nextConfig } = await loadNextConfig("ignore-issue");
  const rules = nextConfig.turbopack?.ignoreIssue;

  assert.ok(Array.isArray(rules), "expected turbopack.ignoreIssue to be an array");
  const agentSkillsRule = rules.find((rule) => String(rule.path).includes("agentSkills"));
  assert.ok(agentSkillsRule, "expected an ignoreIssue rule targeting src/lib/agentSkills/**");
  assert.match(String(agentSkillsRule.description), /Overly broad patterns/);
});

test("turbopack.ignoreIssue suppresses the compression module over-bundling warning (#7051)", async () => {
  // open-sse/services/compression/ruleLoader.ts and
  // .../engines/rtk/filterLoader.ts both define an identical getModuleDir()
  // helper that walks up directories via path.resolve(anchor) +
  // fs.existsSync(...) in a loop with a non-literal argument — the same
  // class of dynamic-path fs access that #6582 suppressed for
  // src/lib/agentSkills/**, but that narrow allowlist glob didn't cover this
  // module, so the warning kept firing (610 times) for every entry point
  // transitively importing the compression module. This guards the config
  // shape so the suppression rule isn't silently dropped in a future edit.
  const { default: nextConfig } = await loadNextConfig("ignore-issue-compression");
  const rules = nextConfig.turbopack?.ignoreIssue;

  assert.ok(Array.isArray(rules), "expected turbopack.ignoreIssue to be an array");
  const compressionRule = rules.find((rule) =>
    String(rule.path).includes("open-sse/services/compression")
  );
  assert.ok(
    compressionRule,
    "expected an ignoreIssue rule targeting open-sse/services/compression/**"
  );
  assert.match(String(compressionRule.description), /Overly broad patterns/);
});

test("optimizePackageImports excludes the internal @omniroute/open-sse workspace (build-OOM guard)", async () => {
  // Regression guard: adding the internal `@omniroute/open-sse` workspace to
  // optimizePackageImports makes Next.js resolve its entire barrel at build
  // time, driving the webpack production pass into a heap runaway that OOM'd
  // even at 28 GB. optimizePackageImports is for EXTERNAL barrel libs only.
  const { default: nextConfig } = await loadNextConfig("optimize-pkg-imports");
  const list = nextConfig.experimental?.optimizePackageImports ?? [];

  assert.ok(Array.isArray(list), "optimizePackageImports should be an array");
  assert.ok(
    !list.includes("@omniroute/open-sse"),
    "do NOT add the internal @omniroute/open-sse workspace to optimizePackageImports — it OOMs the production build"
  );
  // The intended external barrel libs must remain optimized.
  for (const lib of ["lucide-react", "date-fns", "next-intl"]) {
    assert.ok(list.includes(lib), `expected external barrel lib ${lib} to stay optimized`);
  }
});
