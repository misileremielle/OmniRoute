/**
 * POST /v1/audio/transcriptions is frozen in KNOWN_UNCLASSIFIED_SOURCE_SPAWN for one reason: its
 * ffmpeg conversion (open-sse/utils/audioTranscode.ts), gated at the call site. The freeze is
 * per route, so on its own it would also hide any other spawn module the route came to import.
 * This pins the set of spawn modules the route can reach: ffmpeg plus three G-09 baseline sinks
 * it inherits from shared imports. A new spawn module fails here; a new import path to one of
 * these four does not, since the pin is per module, not per chain.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KNOWN_TRANSITIVE_SPAWN_SINKS,
  KNOWN_UNCLASSIFIED_SOURCE_SPAWN,
  TRANSITIVE_SPAWN_INFRA_MODULES,
} from "../../scripts/check/check-route-guard-membership.ts";
import { findTransitivelySpawnCapableRoutes } from "../../scripts/check/lib/spawnImportGraph.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE = "src/app/api/v1/audio/transcriptions/route.ts";

test("the transcription route's only spawn-capable dependency is the ffmpeg converter", () => {
  assert.ok(ROUTE in KNOWN_UNCLASSIFIED_SOURCE_SPAWN, "the route's freeze entry exists");
  const found = findTransitivelySpawnCapableRoutes({
    repoRoot,
    ignoreModules: new Set(Object.keys(TRANSITIVE_SPAWN_INFRA_MODULES)),
  }).find((entry) => entry.route === ROUTE);
  assert.ok(found, "the route still reaches ffmpeg; drop the freeze if it no longer does");
  // The exact set the route reaches today. Three are G-09 baseline sinks, reached through
  // shared imports that every provider route has; the freeze is for the fourth, ffmpeg. Any
  // added sink, baseline or not, fails here and needs its own review.
  const inheritedBaseline = [
    "open-sse/services/qoderCliAcp.ts",
    "open-sse/services/qoderCliSpawn.ts",
    "src/lib/versionManager/binaryManager.ts",
  ];
  for (const sink of inheritedBaseline) {
    assert.ok(sink in KNOWN_TRANSITIVE_SPAWN_SINKS, `${sink} is still a frozen G-09 sink`);
  }
  // The membership gate's stale check cannot tell when ffmpeg goes, because the baseline sinks
  // keep the route spawn-capable. This assertion is what notices: if audioTranscode.ts drops
  // out, remove the route's KNOWN_UNCLASSIFIED_SOURCE_SPAWN entry.
  assert.deepEqual(
    [...found!.sinks.keys()].sort(),
    [...inheritedBaseline, "open-sse/utils/audioTranscode.ts"].sort(),
    "the route's spawn modules changed; if ffmpeg is gone, drop the freeze entry"
  );
});
