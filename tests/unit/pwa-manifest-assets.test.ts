/**
 * Every image the PWA manifest points at must ship in public/ with the size the
 * manifest declares. A missing file makes browsers log manifest errors and drop
 * the install prompt's icon/screenshot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import manifest from "../../src/app/manifest.ts";

const PUBLIC_DIR = path.join(process.cwd(), "public");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): string {
  const header = fs.readFileSync(file).subarray(0, 24);
  assert.equal(header.toString("ascii", 12, 16), "IHDR", `${file} is not a PNG`);
  return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
}

test("manifest icons and screenshots exist in public/ at their declared sizes", () => {
  const { icons = [], screenshots = [] } = manifest();
  const images = [...icons, ...screenshots];
  assert.ok(images.length > 0);
  for (const image of images) {
    const file = path.join(PUBLIC_DIR, image.src);
    assert.ok(fs.existsSync(file), `${image.src} is missing from public/`);
    if (image.type === "image/png" && image.sizes) {
      assert.equal(pngSize(file), image.sizes, `${image.src} size`);
    }
  }
});
