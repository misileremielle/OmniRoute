import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The open-sse → src boundary ratchet (quality-baseline.json) counts one edge per importing file.
// These engine files read their flags through open-sse/utils/registeredFeatureFlag.ts instead of
// src/shared/utils/featureFlags. The helper asks the resolver featureFlags.ts registers
// (DB override > env > definition default); with none registered it reads the env var alone and
// skips the definition default, so it only matches isFeatureFlagEnabled for flags that default off.

// DB isolation comes from the tests/_setup/isolateDataDir.ts preload (a per-process DATA_DIR).
// This file must not set DATA_DIR or delete it: under `--test-isolation=none` (test:unit:fast)
// every file shares one process and one src/lib/db/core.ts, which captures the path on first import.

const core = await import("../../src/lib/db/core.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const { FEATURE_FLAG_DEFINITIONS } =
  await import("../../src/shared/constants/featureFlagDefinitions.ts");
const { isRetryAfterProvenanceEnabled } = await import("../../open-sse/utils/error.ts");

test.after(() => {
  core.resetDbInstance();
});

const MOVED = [
  "open-sse/executors/opencodeResponsesStall.ts",
  "open-sse/handlers/chatCore/streamReadinessFallback.ts",
  "open-sse/handlers/chatCore/streamingTail.ts",
  "open-sse/services/accountFallback.ts",
  "open-sse/services/combo/protectedPriorityStopStatus.ts",
  "open-sse/services/proxyAutoSelector.ts",
  "open-sse/services/quotaPreflight.ts",
  "open-sse/services/streamRecovery.ts",
  "open-sse/utils/error.ts",
  "open-sse/utils/proxyFallback.ts",
  "open-sse/utils/proxyFetch.ts",
];

const SRC_FEATURE_FLAGS_IMPORT =
  /from ["'](?:@\/|(?:\.\.\/)+src\/)shared\/utils\/featureFlags(?:\.ts)?["']/;

test("the moved engine files read flags through the open-sse helper, not src/", () => {
  for (const f of MOVED) {
    const s = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(s, SRC_FEATURE_FLAGS_IMPORT, f);
    assert.match(s, /from "(?:\.\.?\/)+(?:utils\/)?registeredFeatureFlag\.ts"/, f);
  }
});

function engineSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fs.readdirSync("open-sse", { recursive: true, encoding: "utf8" })) {
    if (!/\.(?:ts|tsx|mts)$/.test(f) || f.includes("node_modules")) continue;
    out.set(
      path.join("open-sse", f).replace(/\\/g, "/"),
      fs.readFileSync(path.join("open-sse", f), "utf8")
    );
  }
  return out;
}

// Flag keys read through the helper: literal keys, `const X = "KEY"` constants anywhere in
// open-sse, and the provider-error-rule flags (accountFallback injects the helper as their reader).
function keysReadThroughHelper(): { keys: Map<string, string>; unresolved: string[] } {
  const sources = engineSources();
  const constants = new Map<string, string>();
  for (const s of sources.values()) {
    for (const m of s.matchAll(/\bconst ([A-Z0-9_]+)\s*=\s*"([A-Z0-9_]+)"/g))
      constants.set(m[1], m[2]);
  }
  const keys = new Map<string, string>();
  const unresolved: string[] = [];
  for (const [file, s] of sources) {
    if (file === "open-sse/utils/registeredFeatureFlag.ts") continue;
    for (const m of s.matchAll(
      /\bisRegisteredFeatureFlagEnabled\(\s*(?:"([A-Z0-9_]+)"|([A-Za-z0-9_]+))/g
    )) {
      const key = m[1] ?? constants.get(m[2]);
      if (key) keys.set(key, file);
      else unresolved.push(`${file}: ${m[2]}`);
    }
  }
  const rules = sources.get("open-sse/config/providerErrorRules.ts") ?? "";
  for (const m of rules.matchAll(/isRuleFlagEnabled\(\s*([A-Za-z0-9_.]+)\s*\)/g)) {
    if (m[1] === "key") continue;
    if (m[1] === "optIn.flag") {
      for (const f of rules.matchAll(/\{\s*flag:\s*([A-Z0-9_]+)/g)) {
        const key = constants.get(f[1]);
        if (key) keys.set(key, "open-sse/config/providerErrorRules.ts");
        else unresolved.push(`providerErrorRules.ts: ${f[1]}`);
      }
      continue;
    }
    const key = constants.get(m[1]);
    if (key) keys.set(key, "open-sse/config/providerErrorRules.ts");
    else unresolved.push(`providerErrorRules.ts: ${m[1]}`);
  }
  return { keys, unresolved };
}

test("every flag read through the env-fallback helper defaults to off", () => {
  const { keys, unresolved } = keysReadThroughHelper();
  assert.deepEqual(unresolved, [], "flag key the scan cannot resolve");
  for (const k of ["PROXY_AUTO_SELECT_ENABLED", "MISTRAL_AMBIGUOUS_401_SOFT_LOCKOUT"]) {
    assert.ok(keys.has(k), `scan should find ${k}`);
  }
  const defaultOn = [...keys]
    .filter(([key]) => {
      const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
      return (def?.defaultValue ?? "false") !== "false";
    })
    .map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(
    defaultOn,
    [],
    "a default-on flag read through registeredFeatureFlag.ts turns off wherever the server " +
      "resolver is not registered; read it through src/shared/utils/featureFlags instead"
  );
});

test("the default-on reader is used only for flags whose definition default is on", () => {
  const sources = engineSources();
  const constants = new Map<string, string>();
  for (const src of sources.values()) {
    for (const m of src.matchAll(/\bconst ([A-Z0-9_]+)\s*=\s*"([A-Z0-9_]+)"/g))
      constants.set(m[1], m[2]);
  }
  const misused: string[] = [];
  let reads = 0;
  for (const [file, src] of sources) {
    if (file === "open-sse/utils/registeredFeatureFlag.ts") continue;
    for (const m of src.matchAll(
      /\bisRegisteredDefaultOnFeatureFlagEnabled\(\s*(?:"([A-Z0-9_]+)"|([A-Za-z0-9_]+))/g
    )) {
      reads += 1;
      const key = m[1] ?? constants.get(m[2]);
      const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
      if (def?.defaultValue !== "true") misused.push(`${key ?? m[2]} (${file})`);
    }
  }
  assert.ok(reads > 0, "scan should find EMPTY_STREAM_SIBLING_RECOVERY_ENABLED");
  assert.deepEqual(
    misused,
    [],
    "a default-off flag must be read with isRegisteredFeatureFlagEnabled"
  );
});

test("the DB layer always loads featureFlags.ts, which registers the resolver", () => {
  const coreSrc = fs.readFileSync("src/lib/db/core.ts", "utf8");
  assert.match(coreSrc, /^import \{[^}]*\} from "@\/shared\/utils\/featureFlags";$/m);
  const flags = fs.readFileSync("src/shared/utils/featureFlags.ts", "utf8");
  assert.match(flags, /^registerFeatureFlagResolver\(isFeatureFlagEnabled\);$/m);
});

test("a dashboard override reaches a moved engine file", () => {
  const key = "RETRY_AFTER_PROVENANCE_ENABLED";
  const savedEnv = process.env[key];
  delete process.env[key];
  try {
    assert.equal(isRetryAfterProvenanceEnabled(), false);
    featureFlagsDb.setFeatureFlagOverride(key, "true");
    assert.equal(isRetryAfterProvenanceEnabled(), true);
    featureFlagsDb.removeFeatureFlagOverride(key);
    assert.equal(isRetryAfterProvenanceEnabled(), false);
  } finally {
    featureFlagsDb.removeFeatureFlagOverride(key);
    if (savedEnv === undefined) delete process.env[key];
    else process.env[key] = savedEnv;
  }
});

test("the default-on reader is on without a resolver unless the env turns it off", async () => {
  const { isRegisteredDefaultOnFeatureFlagEnabled } =
    await import("../../open-sse/utils/registeredFeatureFlag.ts");
  const key = Symbol.for("omniroute.featureFlagResolver");
  const owner = globalThis as Record<symbol, unknown>;
  const saved = owner[key];
  delete owner[key];
  try {
    assert.equal(isRegisteredDefaultOnFeatureFlagEnabled("X_FLAG", {}), true);
    assert.equal(isRegisteredDefaultOnFeatureFlagEnabled("X_FLAG", { X_FLAG: "false" }), false);
    assert.equal(isRegisteredDefaultOnFeatureFlagEnabled("X_FLAG", { X_FLAG: "0" }), false);
    assert.equal(isRegisteredDefaultOnFeatureFlagEnabled("X_FLAG", { X_FLAG: "true" }), true);
    owner[key] = () => false;
    assert.equal(isRegisteredDefaultOnFeatureFlagEnabled("X_FLAG", {}), false);
  } finally {
    if (saved === undefined) delete owner[key];
    else owner[key] = saved;
  }
});
