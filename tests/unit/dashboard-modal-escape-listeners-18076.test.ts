/**
 * #18076 — the conversations drawer is a kit `Modal` (Radix Dialog), which already closes on
 * Escape through its own dismissable layer. The page also kept a document-level `keydown`
 * listener that closed the dialog on Escape. That duplicate fires even when Escape was meant
 * for a nested layer (a menu or tooltip inside the dialog), closing the whole dialog. The
 * listener is gone; Escape is covered by Radix. (Upstream also checks profile/page.tsx; this
 * fork removed the profile page with gamification.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASHBOARD = "src/app/(dashboard)/dashboard";
const read = (p: string) => fs.readFileSync(path.join(ROOT, DASHBOARD, p), "utf8");

for (const page of ["conversations/page.tsx"]) {
  test(`${page}: no document-level Escape listener next to the Radix modal`, () => {
    const src = read(page);
    // The page still renders the kit Modal, which owns Escape.
    assert.match(src, /import Modal from "@\/shared\/components\/Modal"/);
    assert.doesNotMatch(src, /document\.addEventListener\(\s*["']keydown["']/);
    assert.doesNotMatch(src, /key === "Escape"/);
  });
}
