import { describe, it } from "node:test";
import assert from "node:assert/strict";
const { mapSyntxModel } = await import("../../open-sse/services/syntxModels.ts");

describe("SYNTX media catalog", () => {
  it("does not change chat model mapping", () => {
    assert.equal(mapSyntxModel("syntx/claude-sonnet-5"), "claude-sonnet-5");
    assert.equal(mapSyntxModel("stx/gpt-5.4"), "gpt-5.4");
  });
});

describe("SYNTX media provider rules", () => {});

describe("SYNTX media poll projection", () => {});

describe("SYNTX media generate flow", () => {});
