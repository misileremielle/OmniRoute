import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = load(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as {
  allowBuilds?: Record<string, boolean>;
};

test("allowBuilds entries are name-only, never version pins", () => {
  const allow = workspace.allowBuilds ?? {};
  const pinned = Object.keys(allow).filter((name) => name.lastIndexOf("@") > 0);
  assert.deepEqual(pinned, [], `pinned allowBuilds keys must be name-only: ${pinned.join(", ")}`);
});

test("allowBuilds covers native dependencies by name and denies onnxruntime-node", () => {
  const allow = workspace.allowBuilds ?? {};
  for (const name of [
    "better-sqlite3",
    "bun",
    "opencode-ai",
    "@playwright/browser-chromium",
    "@huggingface/transformers",
    "sharp",
  ]) {
    assert.equal(allow[name], true, `${name} must be explicitly allowed by name`);
  }
  assert.equal(allow["onnxruntime-node"], false, "onnxruntime-node must be explicitly denied");
});
