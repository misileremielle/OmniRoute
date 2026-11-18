import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { CLI_TOOLS } from "../../src/shared/constants/cliTools";

test("every CLI catalog image points to a bundled public asset", () => {
  const missing = Object.values(CLI_TOOLS).flatMap((tool) =>
    [tool.image, tool.imageLight, tool.imageDark]
      .filter((asset): asset is string => Boolean(asset))
      .filter((asset) => !existsSync(`public${asset}`))
      .map((asset) => `${tool.id}: ${asset}`)
  );

  assert.deepEqual(missing, []);
});
