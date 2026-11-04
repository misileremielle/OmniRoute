import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-qwen-cloud-video-"));
const { resolveProviderServiceKinds: _resolveProviderServiceKinds } =
  await import("../../open-sse/config/mediaServiceKinds.ts");
const { resolveAlibabaProviderMediaBaseUrl } =
  await import("../../src/shared/constants/alibabaProviderRegions.ts");

test("Qwen Cloud media URLs follow its own saved region", () => {
  assert.equal(
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud", { region: "global-sg" }),
    "https://dashscope-intl.aliyuncs.com/api/v1"
  );
  assert.equal(
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud", { region: "china-beijing" }),
    "https://dashscope.aliyuncs.com/api/v1"
  );
  assert.notEqual(
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud", { region: "global-sg" }),
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud-token-plan", { region: "global-sg" })
  );
});
