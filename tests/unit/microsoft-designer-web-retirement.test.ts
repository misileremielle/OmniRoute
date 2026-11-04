import assert from "node:assert/strict";

import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getExecutor } from "../../open-sse/executors/index.ts";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RETIRED_IDS = [
  "microsoft-designer-web",
  "msdesigner",
  "  MICROSOFT-DESIGNER-WEB\t",
  "\nMsDesigner  ",
] as const;

test("Microsoft Designer Web runtime IDs fail closed at the executor seam", async () => {
  for (const providerId of RETIRED_IDS) {
    await assert.rejects(
      () => getExecutor(providerId),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { status?: number }).status, 410);
        assert.equal(error.message, "Provider has been retired from OmniRoute runtime.");
        assert.equal(error.message.includes(providerId.trim()), false);
        return true;
      }
    );
  }
});

test("Microsoft Designer retirement is exact and preserves supported providers", async () => {
  for (const providerId of [
    "microsoft-designer-web-preview",
    "openai",
    "azure",
    "copilot",
    "musespark-web",
    "modelscope",
  ]) {
    await assert.doesNotReject(() => getExecutor(providerId));
  }
});
