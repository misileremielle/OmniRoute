/**
 * The real `@github/copilot` CLI stamps ONE stable device UUID on every call for
 * the life of an install. OmniRoute minted a fresh random one per process, so
 * every restart presented a brand-new machine to the same account — exactly the
 * signal a "one install" fingerprint is supposed to carry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getGitHubCopilotMachineId,
  __resetCopilotMachineIdForTest,
} from "../../open-sse/config/providerHeaderProfiles.ts";

const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the machine id survives a process restart", () => {
  const first = getGitHubCopilotMachineId();
  __resetCopilotMachineIdForTest();
  assert.equal(getGitHubCopilotMachineId(), first);
});

test("the machine id looks like the UUID v4 the CLI sends", () => {
  __resetCopilotMachineIdForTest();
  assert.match(getGitHubCopilotMachineId(), UUID_V4_SHAPE);
});

test("the env override still wins", () => {
  const saved = process.env.GITHUB_COPILOT_MACHINE_ID;
  try {
    process.env.GITHUB_COPILOT_MACHINE_ID = "11111111-2222-4333-8444-555555555555";
    assert.equal(getGitHubCopilotMachineId(), "11111111-2222-4333-8444-555555555555");
  } finally {
    if (saved === undefined) delete process.env.GITHUB_COPILOT_MACHINE_ID;
    else process.env.GITHUB_COPILOT_MACHINE_ID = saved;
    __resetCopilotMachineIdForTest();
  }
});

test("the id is not the same for two different salts", async () => {
  const { getConsistentMachineIdSync } = await import("../../src/shared/utils/machineId.ts");
  assert.notEqual(
    getConsistentMachineIdSync("github-copilot-machine-id"),
    getConsistentMachineIdSync("some-other-install-identity")
  );
});
