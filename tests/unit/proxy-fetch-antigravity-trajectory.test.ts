/**
 * The Cloud Code envelope carries `agent/<agent>/<ts>/<trajectory>/<step>` plus
 * trajectory labels. Both ids must persist for the session and the step must
 * advance — a fresh trajectory claiming step 2 on every request is a shape no
 * CLI produces past its first turn.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetAntigravityTrajectoryStateForTest,
  buildAntigravityEnvelopeIdentity,
} from "../../open-sse/services/antigravityIdentity.ts";

const args = { isClaude: false, credentials: { email: "user@example.com" } };

function parts(identity: { requestId: string }) {
  const [, , , trajectoryId, step] = identity.requestId.split("/");
  return { trajectoryId, step };
}

test("a session keeps its agent and trajectory, and the step advances", () => {
  __resetAntigravityTrajectoryStateForTest();
  const first = buildAntigravityEnvelopeIdentity(args);
  const second = buildAntigravityEnvelopeIdentity(args);
  const third = buildAntigravityEnvelopeIdentity(args);

  const a = parts(first);
  const b = parts(second);
  const c = parts(third);
  assert.equal(b.trajectoryId, a.trajectoryId, "the trajectory must persist");
  assert.equal(c.trajectoryId, a.trajectoryId);
  assert.equal(first.requestId.split("/")[1], second.requestId.split("/")[1], "same agent");
  assert.deepEqual([a.step, b.step, c.step], ["2", "3", "4"]);
  assert.deepEqual(
    [first.labels.last_step_index, second.labels.last_step_index, third.labels.last_step_index],
    ["1", "2", "3"]
  );
  assert.equal(second.labels.trajectory_id, a.trajectoryId);
});

test("distinct conversations get distinct trajectories", () => {
  __resetAntigravityTrajectoryStateForTest();
  const one = buildAntigravityEnvelopeIdentity({ ...args, sessionIdFallback: "conversation-1" });
  const two = buildAntigravityEnvelopeIdentity({ ...args, sessionIdFallback: "conversation-2" });
  assert.notEqual(parts(one).trajectoryId, parts(two).trajectoryId);
  assert.equal(one.sessionId, "conversation-1");
  assert.equal(parts(one).step, "2");
});
