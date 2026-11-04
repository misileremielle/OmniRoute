import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createProviderNodeSchema } from "../../src/shared/validation/schemas/provider.ts";
import { ENDPOINT_CATEGORIES } from "../../src/shared/constants/endpointCategories.ts";
import { SERVICE_KIND_VALUES } from "../../src/shared/constants/serviceKinds.ts";
import { getAllToolDefinitions } from "../../open-sse/mcp-server/toolSearch/catalog.ts";

import { parseAutoPrefix } from "../../open-sse/services/autoCombo/autoPrefix.ts";
import { getModePackNames } from "../../open-sse/services/autoCombo/modePacks.ts";

const root = process.cwd();
const removedRoutes = [
  "v1/completions",
  "v1/moderations",
  "v1/images/generations",
  "v1/images/edits",
  "v1/audio/speech",
  "v1/audio/transcriptions",
  "v1/music/generations",
  "v1/videos/generations",
  "gamification/stream",
  "webhooks",
  "log-export/status",
  "memory",
  "skills",
  "agent-skills",
  "plugins",
  "radar",
  "chaos",
  "settings/reasoning-routing-rules",
  "settings/system-prompt",
  "tunnels",
];

test("removed features have no API route or advertised endpoint", () => {
  for (const route of removedRoutes) {
    assert.equal(existsSync(path.join(root, "src/app/api", route, "route.ts")), false, route);
  }
  const prefixes = ENDPOINT_CATEGORIES.flatMap((category) => category.prefixes);
  for (const removed of [
    "/v1/completions",
    "/v1/images",
    "/v1/audio",
    "/v1/videos",
    "/v1/moderations",
  ]) {
    assert.equal(
      prefixes.some((prefix) => prefix.startsWith(removed)),
      false,
      removed
    );
  }
  for (const route of [
    "chat/completions",
    "responses",
    "messages",
    "embeddings",
    "rerank",
    "search",
    "systemone",
  ]) {
    assert.equal(existsSync(path.join(root, "src/app/api/v1", route, "route.ts")), true, route);
  }
});

test("compatible nodes reject deleted media APIs while retaining chat and embeddings", () => {
  const node = { name: "Example", prefix: "example-node", baseUrl: "https://example.test/v1" };
  for (const apiType of [
    "images",
    "audio",
    "audio-speech",
    "audio-transcriptions",
    "video",
    "music",
  ]) {
    assert.equal(createProviderNodeSchema.safeParse({ ...node, apiType }).success, false, apiType);
  }
  for (const apiType of ["chat", "responses", "embeddings"]) {
    assert.equal(createProviderNodeSchema.safeParse({ ...node, apiType }).success, true, apiType);
  }
  for (const kind of ["image", "video", "music", "tts", "stt"]) {
    assert.equal((SERVICE_KIND_VALUES as readonly string[]).includes(kind), false, kind);
  }
});

test("MCP discovery retains routing tools and omits removed feature tools", () => {
  const names = getAllToolDefinitions().map((tool) => tool.name);
  assert.ok(names.includes("omniroute_get_health"));
  assert.ok(names.includes("omniroute_list_combos"));
  assert.equal(
    names.some((name) => /(?:memory_|skills_|gamification_|plugin_|radar_)/.test(name)),
    false
  );
});

test("startup and build no longer launch removed background jobs", () => {
  for (const file of [
    "src/instrumentation-node.ts",
    "src/lib/initCloudSync.ts",
    "scripts/build/prepublish.ts",
    "scripts/build/colocate-standalone.mjs",
  ]) {
    assert.doesNotMatch(
      readFileSync(path.join(root, file), "utf8"),
      /(?:registerLogExportJob|logExport\/exportChild|startRadarScheduler|startMemoryDecay)/,
      file
    );
  }
});

test("removed Chaos mode cannot be selected as a virtual combo or scoring profile", () => {
  assert.equal(parseAutoPrefix("auto/chaos").valid, false);
  assert.equal(getModePackNames().includes("chaos-mode"), false);
});
