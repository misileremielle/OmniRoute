import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workspace = load(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")) as {
  overrides: Record<string, string>;
  nodeLinker?: string;
};

// pnpm reads the overrides in pnpm-workspace.yaml; npm-style tooling reads the ones in
// package.json. A pin missing from either copy silently leaves that install unpatched.
function flatten(overrides: Record<string, unknown>, parent = ""): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [name, value] of Object.entries(overrides)) {
    const key = parent ? `${parent}>${name}` : name;
    if (typeof value === "string") flat.set(key, value);
    else for (const [k, v] of flatten(value as Record<string, unknown>, name)) flat.set(k, v);
  }
  return flat;
}

test("package.json and pnpm-workspace.yaml pin the same overrides", () => {
  const npmStyle = flatten(pkg.overrides);
  // npm scopes these by parent; pnpm selectors allow one parent, so both become minimatch@9.
  npmStyle.delete("minimatch>brace-expansion");
  npmStyle.delete("minimatch@9>brace-expansion");
  npmStyle.set("minimatch@9>brace-expansion", "^2.1.4");

  assert.deepEqual(
    Object.fromEntries([...npmStyle].sort()),
    Object.fromEntries(Object.entries(workspace.overrides).sort())
  );
});

test("the standalone bundle's flat node_modules layout stays selected", () => {
  assert.equal(workspace.nodeLinker, "hoisted");
});
