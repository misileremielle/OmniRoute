import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("news.json is a v2 feed without commercial details", async () => {
  const source = await readFile(new URL("news.json", root), "utf8");
  const payload = JSON.parse(source);

  assert.equal(payload.schemaVersion, 2);
  assert.doesNotMatch(source, /R\$|US\$|coupon|cupom|discount|desconto/i);
});

test("the generic banner is ID-dismissable", async () => {
  const source = await readFile(
    new URL("src/app/(dashboard)/dashboard/NewsBanner.tsx", root),
    "utf8"
  );

  assert.match(source, /selectActiveNews/);
  assert.match(source, /parseDismissedNewsIds/);
  assert.match(source, /localStorage/);
  assert.match(source, /announcement\.id/);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
});
