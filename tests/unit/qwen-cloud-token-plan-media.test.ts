import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-qwen-token-plan-media-"));
const { resolveProviderServiceKinds: _resolveProviderServiceKinds } =
  await import("../../open-sse/config/mediaServiceKinds.ts");
const { resolveAlibabaProviderMediaBaseUrl } =
  await import("../../src/shared/constants/alibabaProviderRegions.ts");

test("Qwen Cloud Token Plan media URLs follow the saved region", () => {
  assert.equal(
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud-token-plan", { region: "global-sg" }),
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1"
  );
  assert.equal(
    resolveAlibabaProviderMediaBaseUrl("qwen-cloud-token-plan", {
      region: "china-beijing",
    }),
    "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1"
  );
});
