import test from "node:test";
import assert from "node:assert/strict";
import { getModelEndpointMismatchMessage } from "../../src/lib/providerModels/modelEndpointGuard.ts";

test("#16929: declared specialty tags reject the wrong endpoint locally", () => {
  const embedding = { supportedEndpoints: ["embeddings"], endpointCapabilitySource: "declared" };
  const mismatch = getModelEndpointMismatchMessage("local/bge-m3", embedding, "chat");
  assert.match(mismatch || "", /\/v1\/embeddings/);
  assert.match(mismatch || "", /\/v1\/chat\/completions/);
  assert.equal(getModelEndpointMismatchMessage("local/bge-m3", embedding, "embeddings"), null);
});

test("#16929: defaulted and legacy endpoint tags never gate dispatch", () => {
  assert.equal(
    getModelEndpointMismatchMessage(
      "p/m",
      {
        supportedEndpoints: ["chat"],
        endpointCapabilitySource: "defaulted",
      },
      "embeddings"
    ),
    null
  );
  assert.equal(
    getModelEndpointMismatchMessage(
      "p/m",
      {
        supportedEndpoints: ["embeddings"],
      },
      "chat"
    ),
    null
  );
});

test("#16929: operator and inferred tags reject an incorrect route, allow exact match", () => {
  const transcription = {
    supportedEndpoints: ["audio-transcriptions"],
    endpointCapabilitySource: "inferred",
  };
  const bad = getModelEndpointMismatchMessage(
    "gemini/gemini-3.5-transcribe",
    transcription,
    "chat"
  );
  assert.match(bad || "", /Use a supported endpoint instead/);
  assert.match(
    getModelEndpointMismatchMessage(
      "p/m",
      {
        supportedEndpoints: ["rerank"],
        endpointCapabilitySource: "operator",
      },
      "embeddings"
    ) || "",
    /\/v1\/rerank/
  );
});

test("#16929: multimodal chat models remain chat-selectable", () => {
  const model = {
    supportedEndpoints: ["chat", "images"],
    endpointCapabilitySource: "declared",
  };
  assert.equal(getModelEndpointMismatchMessage("p/m", model, "chat"), null);
  assert.equal(
    getModelEndpointMismatchMessage(
      "p/m",
      {
        supportedEndpoints: ["responses"],
        endpointCapabilitySource: "declared",
      },
      "chat"
    ),
    null
  );
});

test("#16929: normalize legacy image alias and preserve trusted multi-endpoint route checks", () => {
  const model = {
    supportedEndpoints: ["images-generations", "rerank"],
    endpointCapabilitySource: "operator",
  };
  assert.equal(getModelEndpointMismatchMessage("p/media", model, "rerank"), null);
  const mismatch = getModelEndpointMismatchMessage("p/media", model, "embeddings");
  assert.match(mismatch || "", /\/v1\/rerank/);
});
