import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  importerDependency,
  packageSnapshots,
  readPnpmLock,
} from "../../../scripts/ci/pnpmLock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = readPnpmLock(root);

test("#17017 ref-parser receives js-yaml 5, not an incompatible nested 4", () => {
  const parsers = packageSnapshots(lock, "@apidevtools/json-schema-ref-parser");
  assert.ok(parsers.length > 0, "ref-parser must remain installed");
  for (const [, parser] of parsers) assert.match(parser.dependencies["js-yaml"], /^5\./);
  assert.match(pkg.dependencies["js-yaml"], /^\^5\./);
  assert.equal(
    pkg.overrides["@apidevtools/json-schema-ref-parser"]["js-yaml"],
    pkg.dependencies["js-yaml"],
    "the ref-parser override must follow the app's own js-yaml range"
  );
  const direct = importerDependency(lock, "js-yaml");
  assert.equal(direct.specifier, pkg.dependencies["js-yaml"]);
  assert.match(direct.version, /^5\./);
});

test("#17017 preserve unrelated packages' intentional js-yaml 4 installations", () => {
  for (const name of ["xmlbuilder2"]) {
    const snapshots = packageSnapshots(lock, name);
    assert.ok(snapshots.length > 0, `missing ${name}`);
    for (const [, snapshot] of snapshots) {
      assert.match(snapshot.dependencies["js-yaml"], /^4\./);
    }
  }
});
