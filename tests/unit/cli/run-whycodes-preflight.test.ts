import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readWhyCodesProviderBaseUrl } from "../../../bin/cli/commands/run.mjs";

// `omniroute run whycodes` fails early unless config.toml has [providers.omniroute].
// null means "no usable entry" (the preflight stops); "" means the entry exists
// without a base URL (the preflight continues without a mismatch warning).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whycodes-preflight-"));
const write = (name: string, body: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("missing config file reads as null", async () => {
  assert.equal(await readWhyCodesProviderBaseUrl(path.join(dir, "absent.toml")), null);
});

test("malformed TOML reads as null", async () => {
  assert.equal(
    await readWhyCodesProviderBaseUrl(write("bad.toml", "[providers.omniroute\n")),
    null
  );
});

test("config without [providers.omniroute] reads as null", async () => {
  const file = write("other.toml", '[providers.other]\nbase_url = "http://x/v1"\n');
  assert.equal(await readWhyCodesProviderBaseUrl(file), null);
});

test("base_url (or api_base) of [providers.omniroute] is returned", async () => {
  const withBase = write("base.toml", '[providers.omniroute]\nbase_url = "http://h:1/v1"\n');
  assert.equal(await readWhyCodesProviderBaseUrl(withBase), "http://h:1/v1");
  const withApiBase = write("api.toml", '[providers.omniroute]\napi_base = "http://h:2/v1"\n');
  assert.equal(await readWhyCodesProviderBaseUrl(withApiBase), "http://h:2/v1");
});

test("[providers.omniroute] without a base URL reads as an empty string", async () => {
  const file = write("empty.toml", '[providers.omniroute]\nname = "omniroute"\n');
  assert.equal(await readWhyCodesProviderBaseUrl(file), "");
});
