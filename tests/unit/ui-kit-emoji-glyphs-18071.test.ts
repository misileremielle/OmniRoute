import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveIcon } from "../../src/shared/constants/iconMap";

// #18071: emoji glyphs rendered as empty boxes on systems without an emoji font
// (Token Balance card, Improve prompt button). They are drawn with the Lucide Icon now.
// Upstream also checks the Token Balance card; this fork removed the tokens page with
// gamification.
const SCREENS = {
  improvePrompt: "src/app/(dashboard)/dashboard/playground/components/ImprovePromptButton.tsx",
} as const;

const EMOJI = /\p{Extended_Pictographic}/u;

test("the Improve prompt button draws the sparkle with the Icon, not the ✨ emoji", () => {
  const source = readFileSync(SCREENS.improvePrompt, "utf8");
  assert.match(source, /export default function ImprovePromptButton\(/);
  assert.doesNotMatch(source, EMOJI, "ImprovePromptButton still renders an emoji glyph");
  assert.match(source, /auto_awesome/);
  assert.ok(resolveIcon("auto_awesome"), "auto_awesome must be in ICON_MAP");
});
