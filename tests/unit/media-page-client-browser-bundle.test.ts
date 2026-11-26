import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { NEXT_CLIENT_POLYFILLED_BUILTINS } from "./client-bundle-no-server-only-10692.test.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function nextClientPolyfills() {
  return {
    name: "next-client-polyfills",
    setup(pluginBuild: {
      onResolve: (
        options: { filter: RegExp },
        callback: (args: { path: string }) => { path: string; external: true } | undefined
      ) => void;
    }) {
      pluginBuild.onResolve({ filter: /^(?:node:)?[a-z_]+$/ }, (args) => {
        const bare = args.path.replace(/^node:/, "");
        return NEXT_CLIENT_POLYFILLED_BUILTINS.has(bare)
          ? { path: args.path, external: true }
          : undefined;
      });
    },
  };
}

async function assertBrowserBundleSafe(relativePath: string) {
  await assert.doesNotReject(
    build({
      absWorkingDir: REPO_ROOT,
      entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
      bundle: true,
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      // esbuild has no Node builtin resolution for the browser target, but Next
      // does polyfill this exact set (`resolve.fallback`). Mark only those
      // external — anything else (fs, child_process) still fails the build, which
      // is what this test is for.
      plugins: [nextClientPolyfills()],
      tsconfig: "tsconfig.json",
      write: false,
    })
  );
}

test("provider detail client entry stays browser-bundle safe", async () => {
  await assertBrowserBundleSafe(
    "../../src/app/(dashboard)/dashboard/providers/[id]/ProviderDetailPageClient.tsx"
  );
});
