import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-hermes-yaml-refuse-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HERMES_HOME = path.join(TEST_DATA_DIR, "hermes");
fs.mkdirSync(process.env.HERMES_HOME, { recursive: true });

const generator = await import("../../src/lib/cli-helper/config-generator/index.ts");

const configPath = () => path.join(process.env.HERMES_HOME as string, "config.yaml");

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// `omniroute config validate|set hermes-agent` go through the generic adapter.
// It must report the refusal as a failure, not wrap the error object as content.
for (const bytes of ['model: "unclosed\n', "false\n"]) {
  test(`generateConfig("hermes-agent") reports a refusal for ${JSON.stringify(bytes)}`, async () => {
    fs.writeFileSync(configPath(), bytes);
    const result = await generator.generateConfig("hermes-agent", {
      baseUrl: "http://localhost:20128/v1",
      apiKey: "test-key",
    });
    assert.equal(result.success, false, "an unparseable config.yaml must not validate");
    assert.match(String(result.error), /refusing to overwrite/);
    assert.equal(result.content, undefined, "no content object may leak out as success");
    assert.equal(fs.readFileSync(configPath(), "utf8"), bytes);
  });
}
