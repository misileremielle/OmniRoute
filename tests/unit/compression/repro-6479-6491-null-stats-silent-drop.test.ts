import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyStackedCompression } from "../../../open-sse/services/compression/strategySelector.ts";

/**
 * Regression coverage for #6479 and #6491: a dispatched stacked-pipeline step whose engine
 * legitimately finds nothing eligible (`session-dedup` with no repeated blocks, `ccr` below its
 * min-chars threshold) returns `{ stats: null }`. Before the fix, `mergeStackStep()` in
 * `stackedStepCore.ts` silently dropped that step from the accumulator: no `engineBreakdown`
 * entry, no `validationWarnings`, no `validationErrors` — zero trace the engine ever ran.
 *
 * Both issues report the exact same symptom for two different registered/known engines, so both
 * are covered here against the shared fix (a `validationWarnings` entry recorded whenever a step
 * returns `stats: null`).
 */
describe("#6479/#6491 — null-stats step no longer silently dropped from the pipeline", () => {
  it("session-dedup with nothing to dedupe is explained in engineBreakdown or validationWarnings", () => {
    // Small markdown table, short rows — well under session-dedup's 80-char/3-line
    // suffix-block threshold, so session-dedup legitimately finds nothing to dedupe.
    const body = {
      messages: [
        {
          role: "user",
          content:
            "| a | b |\n|---|---|\n| 1 | 2 |\n| 1 | 2 |\n| 1 | 2 |\n| 1 | 2 |\n| 1 | 2 |\n| 1 | 2 |",
        },
      ],
    };

    const pipeline = [{ engine: "session-dedup" }, { engine: "rtk" }, { engine: "caveman" }];
    const result = applyStackedCompression(body, pipeline);

    const engines = result.stats?.engineBreakdown?.map((e) => e.engine) ?? [];
    const warnings = result.stats?.validationWarnings ?? [];
    const errors = result.stats?.validationErrors ?? [];

    assert.ok(
      engines.includes("session-dedup") ||
        warnings.some((w) => w.includes("session-dedup")) ||
        errors.some((w) => w.includes("session-dedup")),
      `session-dedup missing from engineBreakdown (${JSON.stringify(engines)}) with no ` +
        `explanation in validationWarnings/validationErrors — matches issue #6479's report`
    );
    // Specifically: the shared no-op reason must be present.
    assert.ok(
      warnings.some((w) => w === "session-dedup: skipped (no eligible content)") ||
        engines.includes("session-dedup"),
      `expected an explicit skip reason for session-dedup, got warnings=${JSON.stringify(warnings)}`
    );
  });
});
