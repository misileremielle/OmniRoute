/**
 * Stage-2 T2 tests for scripts/perf/perf-verdict.mjs (node:test).
 *
 * Covers every case in the T2 spec: ratio and absolute noise, zero/negative
 * absolute values, ratio-with-0 throws, stable negative median not aborting,
 * mixed-sign pairs giving "no change", the threshold floor beating a small
 * noise, and the M6 floor of 10 %.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const verdictCli = path.resolve(here, "../../scripts/perf/perf-verdict.mjs");

const {
  ABORT_EXIT_CODE,
  abortCheck,
  abortCheckInput,
  abortRows,
  abortTable,
  countingPairs,
  effect,
  exactChange,
  noise,
  threshold,
  verdict,
  verdictTable,
} = await import("../../scripts/perf/perf-verdict.mjs");

function runCli(args: string[], input: unknown): Promise<{ code: number; stdout: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-verdict-cli-"));
  const file = path.join(dir, "input.json");
  fs.writeFileSync(file, JSON.stringify(input));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [verdictCli, ...args, file],
      { timeout: 30_000 },
      (error, stdout) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: String(stdout) });
      }
    );
  });
}

interface Pair {
  a: number;
  b: number;
}

test("ratio noise is (max - min) / median", () => {
  // Sorted: 9, 10, 11, 12, 21 -> median 11, spread 12.
  assert.ok(Math.abs(noise("ratio", [10, 12, 9, 11, 21]) - 12 / 11) < 1e-12);
});

test("absolute noise is max - min", () => {
  assert.equal(noise("absolute", [3, 7, 5]), 4);
});

test("absolute metrics accept zero and negative values", () => {
  assert.ok(Math.abs(noise("absolute", [-0.5, 0, 0.3]) - 0.8) < 1e-12);
  assert.equal(effect("absolute", [{ a: 1, b: 0.5 }]), -0.5);
});

test("ratio noise with 0 throws", () => {
  assert.throws(() => noise("ratio", [0, 1, 2]), /needs values > 0/);
});

test("ratio noise with a negative value throws", () => {
  assert.throws(() => noise("ratio", [-1, 1, 2]), /needs values > 0/);
});

test("noise needs at least 2 samples", () => {
  assert.throws(() => noise("ratio", [1]), /at least 2 samples/);
  assert.throws(() => noise("absolute", []), /at least 2 samples/);
});

test("threshold floor wins over a small noise (ratio)", () => {
  // Noise 0.01 -> 2 x noise = 0.02 < default floor 0.05.
  assert.equal(threshold("ratio", 0.01), 0.05);
});

test("threshold uses 2 x noise when it beats the floor (ratio)", () => {
  assert.equal(threshold("ratio", 0.1), 0.2);
});

test("M6 floor is 10 %", () => {
  assert.equal(threshold("ratio", 0.01, { floor: 0.1 }), 0.1);
  assert.equal(threshold("ratio", 0.1, { floor: 0.1 }), 0.2);
});

test("absolute threshold requires a floor", () => {
  assert.equal(threshold("absolute", 0.1, { floor: 1 }), 1);
  assert.equal(threshold("absolute", 1, { floor: 1 }), 2);
  assert.throws(() => threshold("absolute", 0.1), /needs .* floor/);
});

test("ratio effect is the median of b / a - 1", () => {
  const pairs: Pair[] = [
    { a: 100, b: 90 },
    { a: 100, b: 80 },
    { a: 100, b: 110 },
  ];
  // Deltas: -0.1, -0.2, +0.1 -> median -0.1.
  assert.ok(Math.abs(effect("ratio", pairs) - -0.1) < 1e-12);
});

test("ratio effect with a <= 0 throws", () => {
  assert.throws(() => effect("ratio", [{ a: 0, b: 1 }]), /needs a > 0/);
});

test("absolute effect is the median of b - a", () => {
  const pairs: Pair[] = [
    { a: 5, b: 3 },
    { a: 5, b: 6 },
    { a: 5, b: 4 },
  ];
  // Deltas: -2, +1, -1 -> median -1.
  assert.equal(effect("absolute", pairs), -1);
});

test("improvement needs effect <= -T and every pair better", () => {
  const pairs: Pair[] = [
    { a: 100, b: 90 },
    { a: 100, b: 91 },
  ];
  assert.equal(verdict("ratio", pairs, 0.05), "improvement");
});

test("regression needs effect >= +T and every pair worse", () => {
  const pairs: Pair[] = [
    { a: 100, b: 110 },
    { a: 100, b: 111 },
  ];
  assert.equal(verdict("ratio", pairs, 0.05), "regression");
});

test("a mixed-sign pair set gives no change", () => {
  const pairs: Pair[] = [
    { a: 100, b: 50 },
    { a: 100, b: 150 },
    { a: 100, b: 40 },
  ];
  // Median delta -0.5 <= -0.05, but not every pair improves.
  assert.equal(verdict("ratio", pairs, 0.05), "no change");
});

test("a small effect gives no change even when every pair agrees", () => {
  const pairs: Pair[] = [
    { a: 100, b: 99 },
    { a: 100, b: 98.5 },
  ];
  assert.equal(verdict("ratio", pairs, 0.05), "no change");
});

test("abortCheck fires on a ratio guard band above 20 %", () => {
  assert.equal(abortCheck([{ kind: "ratio", guard: true, noise: 0.21 }]), true);
  assert.equal(abortCheck([{ kind: "ratio", guard: true, noise: 0.2 }]), false);
});

test("abortCheck ignores non-guard metrics", () => {
  assert.equal(abortCheck([{ kind: "ratio", guard: false, noise: 0.9 }]), false);
  assert.equal(abortCheck([]), false);
});

test("a stable negative median does not abort", () => {
  // Absolute guard noise is max - min in its own unit: stable samples give
  // noise 0 whatever the sign of the median, so this stays under the caps.
  assert.ok(Math.abs(noise("absolute", [-3.2, -3.1, -3.15]) - 0.1) < 1e-9);
  assert.equal(abortCheck([{ kind: "absolute", guard: true, noise: 0.1, cap: 5 }]), false);
});

test("abortCheck fires when an absolute guard noise is above its cap", () => {
  // Heap growth cap 5 MB, M7 statements cap 2 counts.
  assert.equal(abortCheck([{ kind: "absolute", guard: true, noise: 5.1, cap: 5 }]), true);
  assert.equal(abortCheck([{ kind: "absolute", guard: true, noise: 5, cap: 5 }]), false);
  assert.equal(abortCheck([{ kind: "absolute", guard: true, noise: 3, cap: 2 }]), true);
  assert.equal(abortCheck([{ kind: "absolute", guard: true, noise: 2, cap: 2 }]), false);
});

test("abortCheck needs a cap for absolute guards", () => {
  assert.throws(() => abortCheck([{ kind: "absolute", guard: true, noise: 1 }]), /cap/);
});

test("exactChange reports M5 sizes", () => {
  assert.equal(exactChange(10, 10), "same");
  assert.equal(exactChange(10, 11), "larger");
  assert.equal(exactChange(11, 10), "smaller");
});

test("unknown kinds throw", () => {
  assert.throws(() => noise("other", [1, 2]), /unknown metric kind/);
  assert.throws(() => threshold("other", 0.1), /unknown metric kind/);
  assert.throws(() => effect("other", [{ a: 1, b: 2 }]), /unknown metric kind/);
});

test("abortTable renders the abort Markdown columns (metric, kind, noise, cap, over?)", () => {
  const table = abortTable([
    { name: "M8", kind: "ratio", baselineSamples: [100, 100, 100] },
    { name: "M7", kind: "absolute", baselineSamples: [1, 2, 3], cap: 2 },
  ]) as string;
  const lines = table.split("\n");
  assert.equal(lines[0], "| metric | kind | noise | cap | over? |");
  assert.match(lines[2], /\| M8 \| ratio \| 0 \| 20% \| no \|/);
  assert.match(lines[3], /\| M7 \| absolute \| 2 \| 2 \| no \|/);
  const over = abortTable([
    { name: "M8", kind: "ratio", baselineSamples: [100, 200, 100] },
  ]) as string;
  assert.match(over.split("\n")[2], /\| yes \|/);
});

test("abort CLI exits 3 when abortCheck is true, 0 otherwise", async () => {
  const over = await runCli(["--abort"], {
    metrics: [{ name: "M8", kind: "ratio", guard: true, baselineSamples: [100, 200, 100] }],
  });
  assert.equal(over.code, ABORT_EXIT_CODE);
  assert.equal(over.code, 3);
  assert.match(over.stdout, /\| metric \| kind \| noise \| cap \| over\? \|/);
  assert.match(over.stdout, /\| M8 \| ratio \|.*\| yes \|/);

  const calm = await runCli(["--abort"], {
    metrics: [{ name: "M8", kind: "ratio", guard: true, baselineSamples: [100, 100, 100] }],
  });
  assert.equal(calm.code, 0);
  assert.match(calm.stdout, /\| no \|/);
});

// ── Addendum A1: M10/M11 fields ────────────────────────────────────────────────────────────────────

const sized = (a: number, b: number, sizeA = 3000, sizeB = 3000) => ({ a, b, sizeA, sizeB });

test("A1: an abort-exempt band is shown but never aborts; others still do", async () => {
  const m10 = { name: "M10", kind: "ratio", abortExempt: true, baselineSamples: [100, 200, 100] };
  const rows = abortRows([m10]);
  assert.equal(rows[0].over, true);
  assert.equal(rows[0].exempt, true);
  assert.deepEqual(abortCheckInput(rows), []);
  assert.match(abortTable([m10]) as string, /\| M10 \| ratio \| 1 \| 20% \| yes \(exempt\)/);
  const exempt = await runCli(["--abort"], { metrics: [m10] });
  assert.equal(exempt.code, 0);
  const both = await runCli(["--abort"], {
    metrics: [m10, { name: "M8", kind: "ratio", baselineSamples: [100, 200, 100] }],
  });
  assert.equal(both.code, ABORT_EXIT_CODE);
});

test("A1: fewer baseline samples than minSamples is not measured: no abort, no verdict", async () => {
  const m10 = {
    name: "M10",
    kind: "ratio",
    minSamples: 4,
    baselineSamples: [100, 300, 100],
    requiredPairs: 3,
    pairs: [sized(100, 50), sized(100, 50), sized(100, 50)],
  };
  assert.equal(abortRows([m10])[0].notMeasured, true);
  assert.match(abortTable([m10]) as string, /\| M10 \| ratio \| - \| - \| not measured \|/);
  assert.equal((await runCli(["--abort"], { metrics: [m10] })).code, 0);
  assert.match(verdictTable([m10]) as string, /\| M10 \| - \| - \| - \| - \| not measured \|/);
  assert.throws(() => abortRows([{ ...m10, minSamples: 1 }]), /minSamples must be/);
});

test("A1: countingPairs drops invalid runs, missing sizes and size mismatches", () => {
  const { kept, dropped } = countingPairs({
    pairs: [
      sized(100, 90),
      null,
      { a: 100, b: 90 }, // no sizes: never counts
      sized(100, 90, 3000, 2999),
      { a: 100, b: null, sizeA: 1, sizeB: 1 },
    ],
  });
  assert.deepEqual(kept, [{ a: 100, b: 90 }]);
  assert.deepEqual(dropped, [
    "pair 2: invalid run",
    "pair 3: catalog size missing",
    "pair 4: catalog size 3000 -> 2999",
    "pair 5: invalid run",
  ]);
  // A fix's addendum may state the size change.
  assert.equal(
    countingPairs({ allowedSizeDelta: -762, pairs: [sized(100, 90, 3762, 3000)] }).kept.length,
    1
  );
});

test("A1: requiredPairs gives no verdict when too few pairs count, a verdict otherwise", () => {
  const base = { name: "M10", kind: "ratio", baselineSamples: [100, 101, 102], requiredPairs: 3 };
  const unsized = verdictTable([
    {
      ...base,
      pairs: [
        { a: 100, b: 50 },
        { a: 100, b: 50 },
        { a: 100, b: 50 },
      ],
    },
  ]) as string;
  assert.match(unsized, /no verdict: 0 of 3 pairs count \(pair 1: catalog size missing;/);
  const short = verdictTable([
    { ...base, pairs: [sized(100, 50), null, sized(100, 50)] },
  ]) as string;
  assert.match(
    short,
    /\| M10 \| - \| - \| - \| - \| no verdict: 2 of 3 pairs count \(pair 2: invalid run\) \|/
  );
  const full = verdictTable([
    { ...base, pairs: [sized(100, 50), sized(100, 52), sized(100, 51)] },
  ]) as string;
  assert.match(full, /\| M10 \| 100 \| 51 \| -49% \| 5% \| improvement \|/);
  assert.throws(() => verdictTable([{ ...base, requiredPairs: 0, pairs: [] }]), /requiredPairs/);
});

test("A2: sizeCheck false counts unsized pairs; only false is allowed; no delta with it", () => {
  const base = {
    name: "M12a",
    kind: "ratio",
    baselineSamples: [100, 101, 102],
    requiredPairs: 3,
    sizeCheck: false,
  };
  const pairs = [{ a: 100, b: 50 }, null, { a: 100, b: 52 }];
  assert.deepEqual(countingPairs({ ...base, pairs }), {
    kept: [
      { a: 100, b: 50 },
      { a: 100, b: 52 },
    ],
    dropped: ["pair 2: invalid run"],
  });
  assert.match(
    verdictTable([{ ...base, pairs }]) as string,
    /no verdict: 2 of 3 pairs count \(pair 2: invalid run\)/
  );
  const full = verdictTable([
    {
      ...base,
      pairs: [
        { a: 100, b: 50 },
        { a: 100, b: 52 },
        { a: 100, b: 51 },
      ],
    },
  ]) as string;
  assert.match(full, /\| M12a \| 100 \| 51 \| -49% \| 5% \| improvement \|/);
  assert.throws(() => countingPairs({ ...base, sizeCheck: true, pairs }), /only be false/);
  assert.throws(
    () => countingPairs({ ...base, allowedSizeDelta: 0, pairs }),
    /needs the size check/
  );
});

test("A1: a ratio threshold of 100 % or more is flagged: no improvement can be shown", () => {
  // band (250 - 100) / 150 = 1 -> T = 2.
  const wide = { name: "M10", kind: "ratio", abortExempt: true, baselineSamples: [100, 150, 250] };
  assert.equal(abortRows([wide])[0].noImprovementPossible, true);
  assert.match(abortTable([wide]) as string, /T >= 100 %: no improvement can be shown/);
  // band 40 / 120 = 0.33 -> T = 0.67: still possible.
  const narrow = { ...wide, baselineSamples: [100, 120, 140] };
  assert.equal(abortRows([narrow])[0].noImprovementPossible, false);
});

test("A1: metrics without the new fields behave as before", () => {
  const rows = abortRows([{ name: "M8", kind: "ratio", baselineSamples: [100, 200, 100] }]);
  assert.deepEqual(abortCheckInput(rows), [{ kind: "ratio", guard: true, noise: 1 }]);
  assert.throws(
    () => verdictTable([{ name: "M8", kind: "ratio", baselineSamples: [1, 1], pairs: [null] }]),
    /finite numeric \{a, b\} pairs/
  );
});

test("guard: false rows are reported only: shown, never abort, absolute ones need no cap", async () => {
  const wideRatio = { name: "M2b", kind: "ratio", guard: false, baselineSamples: [100, 200, 100] };
  const capless = { name: "M7 stream", kind: "absolute", guard: false, baselineSamples: [1, 9] };
  const rows = abortRows([wideRatio, capless]);
  assert.equal(rows[0].reported, true);
  assert.equal(rows[0].over, true);
  assert.equal(rows[1].cap, null);
  assert.equal(rows[1].noise, 8);
  assert.deepEqual(abortCheckInput(rows), []);
  const table = abortTable([wideRatio, capless]) as string;
  assert.match(table, /\| M2b \| ratio \| 1 \| 20% \| yes \(reported only\) \|/);
  assert.match(table, /\| M7 stream \| absolute \| 8 \| - \| - \(reported only\) \|/);
  assert.equal((await runCli(["--abort"], { metrics: [wideRatio, capless] })).code, 0);
  // A guard next to them still aborts.
  const both = await runCli(["--abort"], {
    metrics: [
      wideRatio,
      capless,
      { name: "M8", kind: "ratio", guard: true, baselineSamples: [100, 200, 100] },
    ],
  });
  assert.equal(both.code, ABORT_EXIT_CODE);
});

test("guard: missing still counts as a guard; a bad cap still throws for reported rows", () => {
  // Fail-safe: only an explicit false relaxes the check.
  assert.throws(
    () => abortRows([{ name: "M4", kind: "absolute", baselineSamples: [1, 2] }]),
    /finite non-negative cap/
  );
  assert.throws(
    () => abortRows([{ name: "M4", kind: "absolute", guard: true, baselineSamples: [1, 2] }]),
    /finite non-negative cap/
  );
  assert.throws(
    () =>
      abortRows([{ name: "M4", kind: "absolute", guard: false, cap: -1, baselineSamples: [1, 2] }]),
    /finite non-negative cap/
  );
  const withCap = abortRows([
    { name: "M4", kind: "absolute", guard: false, cap: 2, baselineSamples: [1, 9] },
  ]);
  assert.equal(withCap[0].over, true);
  assert.deepEqual(abortCheckInput(withCap), []);
});

test("verdictTable renders the CLI Markdown columns", () => {
  const table = verdictTable([
    {
      name: "M8",
      kind: "ratio",
      guard: true,
      baselineSamples: [100, 100, 100],
      pairs: [
        { a: 100, b: 90 },
        { a: 100, b: 91 },
      ],
    },
  ]) as string;
  const lines = table.split("\n");
  assert.equal(lines[0], "| metric | A median | B median | effect | T | verdict |");
  assert.match(lines[2], /\| M8 \| 100 \| 90\.5 \| -9\.5% \| 5% \| improvement \|/);
});
