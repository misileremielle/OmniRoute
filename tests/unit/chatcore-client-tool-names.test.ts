import test from "node:test";
import assert from "node:assert/strict";

const { mergeInjectedFallbackOwnerNames, resolveToolOwnerId } =
  await import("../../open-sse/handlers/chatCore/clientToolNames.ts");

test("mergeInjectedFallbackOwnerNames: adds name only when enabled=true, convertedToolCount>0, toolName non-null, and not already in client tools", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: ["memory_search"] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
    { enabled: true, toolName: null, convertedToolCount: 1 },
    { enabled: false, toolName: "omniroute_web_fetch", convertedToolCount: 3 },
    { enabled: true, toolName: "omniroute_web_fetch", convertedToolCount: 0 },
  ]);

  assert.deepEqual(result.builtinToolNames, ["memory_search", "omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: does not mutate input injectionResult", () => {
  const input = { builtinToolNames: ["original"] };
  const plans = [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 1 }];
  const result = mergeInjectedFallbackOwnerNames(input, plans);

  // input must be unchanged
  assert.deepEqual(input.builtinToolNames, ["original"]);
  // result is a new object
  assert.notEqual(result, input);
  assert.deepEqual(result.builtinToolNames, ["original", "omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: skips name already present in pre-conversion client tools", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: ["omniroute_web_search"] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
  ]);

  // Must not duplicate — omniroute_web_search already present
  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: client has omniroute_web_search → not added to builtinToolNames even if enabled=true", () => {
  // Scenario: client sends {type:"web_search"} plus function named omniroute_web_search.
  // prepareWebSearchFallbackBody emits enabled=true, convertedToolCount=2 (from the
  // builtin conversion) but the synthetic tool was NOT added because client already has it.
  // mergeInjectedFallbackOwnerNames must check pre-conversion client names.
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 }],
    ["omniroute_web_search"]
  );

  // Must NOT add omniroute_web_search — client already owns it
  assert.deepEqual(result.builtinToolNames, []);
});

test("mergeInjectedFallbackOwnerNames: client has omniroute_web_fetch → not added to builtinToolNames", () => {
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_fetch", convertedToolCount: 1 }],
    ["omniroute_web_fetch"]
  );

  assert.deepEqual(result.builtinToolNames, []);
});

test("mergeInjectedFallbackOwnerNames: client does NOT have the fallback name → added to builtinToolNames", () => {
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 }],
    ["some_other_tool"]
  );

  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: no preConversionClientToolNames provided → falls back to existing behavior", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: [] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
  ]);

  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});

test("resolveToolOwnerId returns the API key id only when it is a non-empty string", () => {
  assert.equal(resolveToolOwnerId({ id: "key-1" }), "key-1");
  assert.equal(resolveToolOwnerId({ id: "   " }), null);
  assert.equal(resolveToolOwnerId({ id: 7 }), null);
  assert.equal(resolveToolOwnerId(null), null);
});
