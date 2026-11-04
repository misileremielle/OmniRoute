import assert from "node:assert/strict";
import test from "node:test";

import { MODE_PACKS } from "../../../open-sse/services/autoCombo/modePacks.ts";
import {
  MODE_PACK_OPTIONS,
  ROUTER_STRATEGY_OPTIONS,
} from "../../../src/lib/combos/intelligentRouting.ts";

// Importing the engine from a test is free; importing it from the client module
// would not be, which is why the dashboard keeps its own option list. This test is
// what keeps that list honest.

// "custom" is the only option that is not a pack: it means "use the sliders".
const NOT_A_PACK = new Set(["custom"]);

test("every shipped mode pack is offered in the dashboard", () => {
  const offered = MODE_PACK_OPTIONS.map((option) => option.id).filter((id) => !NOT_A_PACK.has(id));
  assert.deepEqual(
    [...offered].sort(),
    Object.keys(MODE_PACKS).sort(),
    "a pack the engine ships cannot be selected from the dashboard (or vice versa)"
  );
});

test("the only non-pack option is the manual one", () => {
  const unknown = MODE_PACK_OPTIONS.map((option) => option.id).filter(
    (id) => !NOT_A_PACK.has(id) && !(id in MODE_PACKS)
  );
  assert.deepEqual(unknown, [], "an option id matches no mode pack and is not 'custom'");
});

test("chaos-mode pack is not offered in the dashboard", () => {
  const chaos = MODE_PACK_OPTIONS.find((option) => option.id === "chaos-mode");
  assert.equal(chaos, undefined);
});

test("no strategy label states a factor count", () => {
  const stale = ROUTER_STRATEGY_OPTIONS.filter((option) => /\d+[- ]factor/i.test(option.label));
  assert.deepEqual(
    stale.map((option) => option.label),
    [],
    "a label repeats a number the engine owns; it will go stale and no gate reads labels"
  );
});
