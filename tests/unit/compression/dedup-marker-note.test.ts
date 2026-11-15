/**
 * The stacked pipeline's marker-protocol post-pass (#8033) explains session-dedup's
 * `[dedup:ref sha=...]` marker with one leading system note — no tool involved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyStackedCompression } from "../../../open-sse/services/compression/index.ts";
import {
  DEDUP_PROTOCOL_SENTINEL,
  applyDedupProtocolInstruction,
  injectDedupProtocolInstruction,
} from "../../../open-sse/services/compression/engines/session-dedup/markerNote.ts";
import type { CompressionPipelineStep } from "../../../open-sse/services/compression/types.ts";

type Msg = { role: string; content: unknown };

const DEDUP_MARKER = "[dedup:ref sha=deadbeef]";
const dedupOnly: CompressionPipelineStep[] = [{ engine: "session-dedup" }];

const systems = (messages: Msg[]) => messages.filter((m) => m.role === "system");

describe("dedup marker note", () => {
  it("prepends one system note when a dedup marker is present", () => {
    const messages: Msg[] = [{ role: "user", content: "earlier text\n" + DEDUP_MARKER }];
    const out = injectDedupProtocolInstruction(messages);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "system");
    assert.ok((out[0].content as string).startsWith(DEDUP_PROTOCOL_SENTINEL));
    assert.ok(!(out[0].content as string).includes("retrieve"), "no tool is announced");
  });

  it("is a no-op without a marker and returns the same array", () => {
    const messages: Msg[] = [{ role: "user", content: "plain" }];
    assert.equal(injectDedupProtocolInstruction(messages), messages);
  });

  it("does not stack when a replayed history already carries the note", () => {
    const once = injectDedupProtocolInstruction([{ role: "user", content: DEDUP_MARKER }]);
    assert.equal(injectDedupProtocolInstruction(once), once);
  });

  it("treats the legacy [CCR protocol] note as already present", () => {
    const messages: Msg[] = [
      { role: "system", content: "[CCR protocol] old note" },
      { role: "user", content: DEDUP_MARKER },
    ];
    assert.equal(injectDedupProtocolInstruction(messages), messages);
  });

  it("finds markers inside content-part arrays", () => {
    const out = injectDedupProtocolInstruction([
      { role: "user", content: [{ type: "text", text: DEDUP_MARKER }] },
    ]);
    assert.equal(systems(out).length, 1);
  });

  it("fails open on a body without messages", () => {
    const body = { model: "m" };
    assert.deepEqual(applyDedupProtocolInstruction(body), { body, injected: false });
  });

  it("the stacked pipeline applies it after the engines", () => {
    const body: Record<string, unknown> = {
      model: "gpt-4",
      messages: [{ role: "user", content: "earlier text\n" + DEDUP_MARKER }],
    };
    const result = applyStackedCompression(body, dedupOnly);
    const messages = result.body["messages"] as Msg[];
    assert.equal(systems(messages).length, 1);
    assert.ok((systems(messages)[0].content as string).startsWith(DEDUP_PROTOCOL_SENTINEL));
  });

  it("the stacked pipeline adds nothing when no marker is present", () => {
    const body: Record<string, unknown> = {
      model: "gpt-4",
      messages: [{ role: "user", content: "a short message" }],
    };
    const result = applyStackedCompression(body, dedupOnly);
    assert.equal(systems(result.body["messages"] as Msg[]).length, 0);
  });
});
