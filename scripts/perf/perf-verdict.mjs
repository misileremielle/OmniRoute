/**
 * Stage-2 T2: step-10/step-11/step-12 decision rules ("Noise and decision rules").
 *
 * Pure functions, exported, plus a small CLI. Implements the approved plan
 * (`_tasks/superpowers/plans/2026-11-16-slimming-perf-experiment.md`) exactly:
 *
 * - Ratio metrics (strictly positive: times and sizes): M1, M2a, M2b, M3,
 *   M4 retained heap and us/op, M6, M8, M9a.
 *   - Noise band = (max - min) / median of the step-10 samples.
 *   - Threshold T = max(5 %, 2 x band); M6: max(10 %, 2 x band).
 *   - Effect of B vs A = median over pairs of (B / A - 1).
 * - Absolute metrics (can be 0 or negative): M4 heap growth (MB), M7 counts.
 *   - Noise = max - min of the step-10 samples, in the metric's unit.
 *   - Threshold T = max(floor, 2 x noise); floor 1 MB for heap growth,
 *     1 count per window for M7.
 *   - Effect of B vs A = median over pairs of (B - A).
 * - Improvement: effect <= -T and every pair improves. Regression: effect >= +T
 *   and every pair is worse. Anything else: no change.
 * - Abort after step 10: stop before step 11 and report when a guard ratio
 *   metric has band > 20 %, or an absolute guard metric's noise (max - min,
 *   its own unit) is above its cap: heap growth noise > 5 MB, M7 statement
 *   noise > 2 counts per window. These caps do not depend on the sign or size
 *   of the median.
 *
 * CLI: `node scripts/perf/perf-verdict.mjs <comparison.json>` prints a Markdown
 * table: metric, A median, B median, effect, T, verdict.
 *
 * Abort CLI: `node scripts/perf/perf-verdict.mjs --abort <noise.json>` prints a
 * Markdown table: metric, kind, noise, cap or 20 %, over? It exits 3 when
 * abortCheck is true, 0 otherwise.
 *
 * Abort input shape:
 * {
 *   "metrics": [
 *     { "name": "M8", "kind": "ratio" | "absolute", "guard": true,
 *       "baselineSamples": [12.1, 12.4, 11.9], "cap": 2 }
 *   ]
 * }
 * Ratio guards compare the band against 20 %; absolute guards against `cap`.
 *
 * Input shape:
 * {
 *   "metrics": [
 *     {
 *       "name": "M8 non-streaming median",
 *       "kind": "ratio" | "absolute",
 *       "guard": true,
 *       "baselineSamples": [12.1, 12.4, 11.9],
 *       "pairs": [{ "a": 12.1, "b": 11.5 }, ...],
 *       "floor": 0.1,   // required for absolute; optional override for ratio
 *       "cap": 2        // required for absolute guards (abort check)
 *     }
 *   ]
 * }
 *
 * For ratio metrics the default floor is 0.05 (M6 passes floor 0.10). For
 * absolute metrics `floor` is required (heap growth 1 MB, M7 1 count). For
 * absolute guards `cap` is required (heap growth 5 MB, M7 statements 2).
 *
 * Addendum A1 (cold /v1/models, M10/M11) adds optional fields; metrics without them behave
 * exactly as above:
 * - `abortExempt: true` (abort input): the band is shown but never aborts (M10, Proxy's choice).
 * - `minSamples: n` (both inputs): fewer valid baseline samples make the metric "not
 *   measured": no abort, no verdict. M10 uses 4 (4 of 5 step-10 runs), or 3 after a CPU change.
 * - `requiredPairs: n` (comparison input): pairs may then be null (an invalid run), and each
 *   must carry `sizeA`/`sizeB` (catalog sizes). A pair counts only if a, b, sizeA and sizeB are
 *   all numbers and sizeB - sizeA equals `allowedSizeDelta` (default 0, or the change a fix's
 *   addendum states); a pair without sizes never counts. Fewer counting pairs than
 *   `requiredPairs` gives "no verdict".
 * - Every ratio abort row reports `noImprovementPossible` when T >= 100 %: B / A - 1 is never
 *   below -1, so no improvement can be shown. The abort table prints it for exempt rows (A1:
 *   the step-10 checkpoint flags it for M10).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RATIO_FLOOR = 0.05;
export const ABORT_RATIO_BAND = 0.2;

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function checkSamples(kind, samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error(`${kind} noise needs at least 2 samples`);
  }
  for (const v of samples) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${kind} noise needs finite numeric samples`);
    }
  }
}

function checkPairs(kind, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(`${kind} effect needs at least 1 pair`);
  }
  for (const p of pairs) {
    if (
      p === null ||
      typeof p !== "object" ||
      typeof p.a !== "number" ||
      typeof p.b !== "number" ||
      !Number.isFinite(p.a) ||
      !Number.isFinite(p.b)
    ) {
      throw new Error(`${kind} effect needs finite numeric {a, b} pairs`);
    }
  }
}

/**
 * Noise band of the step-10 samples: (max - min) / median for ratio
 * (values must be > 0, else throws), max - min for absolute.
 */
export function noise(kind, samples) {
  checkSamples(kind, samples);
  const spread = Math.max(...samples) - Math.min(...samples);
  if (kind === "ratio") {
    if (samples.some((v) => v <= 0)) {
      throw new Error("ratio noise needs values > 0");
    }
    return spread / median(samples);
  }
  if (kind === "absolute") {
    return spread;
  }
  throw new Error(`unknown metric kind: ${kind}`);
}

/**
 * Keep threshold T. Ratio: max(opts.floor ?? 0.05, 2 x noise). Absolute:
 * max(opts.floor, 2 x noise), where floor is required.
 */
export function threshold(kind, noiseValue, opts = {}) {
  if (typeof noiseValue !== "number" || !Number.isFinite(noiseValue) || noiseValue < 0) {
    throw new Error(`${kind} threshold needs a finite non-negative noise`);
  }
  if (kind === "ratio") {
    const floor = opts.floor ?? RATIO_FLOOR;
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
      throw new Error("ratio threshold needs a finite non-negative floor");
    }
    return Math.max(floor, 2 * noiseValue);
  }
  if (kind === "absolute") {
    if (typeof opts.floor !== "number" || !Number.isFinite(opts.floor) || opts.floor < 0) {
      throw new Error("absolute threshold needs a finite non-negative floor");
    }
    return Math.max(opts.floor, 2 * noiseValue);
  }
  throw new Error(`unknown metric kind: ${kind}`);
}

/**
 * Effect of B vs A over pairs [{a, b}]. Ratio: median of b / a - 1
 * (a must be > 0). Absolute: median of b - a. Lower is better.
 */
export function effect(kind, pairs) {
  checkPairs(kind, pairs);
  if (kind === "ratio") {
    if (pairs.some((p) => p.a <= 0)) {
      throw new Error("ratio effect needs a > 0");
    }
    return median(pairs.map((p) => p.b / p.a - 1));
  }
  if (kind === "absolute") {
    return median(pairs.map((p) => p.b - p.a));
  }
  throw new Error(`unknown metric kind: ${kind}`);
}

/**
 * "improvement" if effect <= -T and every pair has b < a; "regression" if
 * effect >= +T and every pair has b > a; else "no change".
 */
export function verdict(kind, pairs, T) {
  if (typeof T !== "number" || !Number.isFinite(T) || T < 0) {
    throw new Error(`${kind} verdict needs a finite non-negative threshold`);
  }
  const e = effect(kind, pairs);
  if (e <= -T && pairs.every((p) => p.b < p.a)) {
    return "improvement";
  }
  if (e >= T && pairs.every((p) => p.b > p.a)) {
    return "regression";
  }
  return "no change";
}

/**
 * Abort after step 10: true when a ratio guard has band > 0.20, or when an
 * absolute guard's noise is above its cap (heap growth 5 MB, M7 statements 2).
 * The caps are independent of the median. Each entry:
 * { kind: "ratio" | "absolute", guard: boolean, noise: number, cap?: number }.
 */
export function abortCheck(metrics) {
  if (!Array.isArray(metrics)) {
    throw new Error("abortCheck needs an array of metrics");
  }
  for (const m of metrics) {
    if (m === null || typeof m !== "object") {
      throw new Error("abortCheck needs metric objects");
    }
    if (m.guard !== true) {
      continue;
    }
    if (typeof m.noise !== "number" || !Number.isFinite(m.noise) || m.noise < 0) {
      throw new Error("abortCheck needs a finite non-negative noise per metric");
    }
    if (m.kind === "ratio") {
      if (m.noise > ABORT_RATIO_BAND) {
        return true;
      }
    } else if (m.kind === "absolute") {
      if (typeof m.cap !== "number" || !Number.isFinite(m.cap) || m.cap < 0) {
        throw new Error("abortCheck needs a finite non-negative cap for absolute guards");
      }
      if (m.noise > m.cap) {
        return true;
      }
    } else {
      throw new Error(`unknown metric kind: ${m.kind}`);
    }
  }
  return false;
}

/** M5 exact comparison: "same" | "larger" | "smaller". */
export function exactChange(a, b) {
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    !Number.isFinite(a) ||
    !Number.isFinite(b)
  ) {
    throw new Error("exactChange needs finite numeric sizes");
  }
  if (b === a) {
    return "same";
  }
  return b > a ? "larger" : "smaller";
}

function readMetrics(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.metrics)) {
    throw new Error(`expected { metrics: [...] } in ${file}`);
  }
  return parsed.metrics;
}

function formatNumber(v) {
  if (!Number.isFinite(v)) {
    return String(v);
  }
  const rounded = Number(v.toFixed(4));
  return String(rounded);
}

function formatEffect(kind, e) {
  if (kind === "ratio") {
    return `${formatNumber(e * 100)}%`;
  }
  return formatNumber(e);
}

/** A1: fewer valid baseline samples than `minSamples` (when set) means "not measured". */
export function notMeasured(m) {
  if (m.minSamples === undefined) return false;
  if (!Number.isInteger(m.minSamples) || m.minSamples < 2) {
    throw new Error("minSamples must be an integer >= 2");
  }
  return !Array.isArray(m.baselineSamples) || m.baselineSamples.length < m.minSamples;
}

/** A1: a ratio threshold at or above 100 % can never be met by an improvement. */
export function noImprovementPossible(T) {
  return T >= 1;
}

/**
 * A1: the pairs that count for a metric with `requiredPairs`. A pair counts when it is an
 * object with numeric a, b, sizeA and sizeB, and sizeB - sizeA === allowedSizeDelta (default
 * 0). Sizes are required: a pair that does not show matching catalogs never counts. Returns
 * the counting pairs and a reason for each dropped one.
 */
export function countingPairs(m) {
  const delta = m.allowedSizeDelta ?? 0;
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    throw new Error("allowedSizeDelta must be a finite number");
  }
  const kept = [];
  const dropped = [];
  (Array.isArray(m.pairs) ? m.pairs : []).forEach((p, i) => {
    const k = i + 1;
    if (p === null || typeof p !== "object") return dropped.push(`pair ${k}: invalid run`);
    if (![p.a, p.b].every((v) => typeof v === "number" && Number.isFinite(v))) {
      return dropped.push(`pair ${k}: invalid run`);
    }
    if (![p.sizeA, p.sizeB].every((v) => typeof v === "number" && Number.isFinite(v))) {
      return dropped.push(`pair ${k}: catalog size missing`);
    }
    if (p.sizeB - p.sizeA !== delta) {
      return dropped.push(`pair ${k}: catalog size ${p.sizeA} -> ${p.sizeB}`);
    }
    kept.push({ a: p.a, b: p.b });
  });
  return { kept, dropped };
}

export function verdictTable(metrics) {
  const rows = metrics.map((m) => {
    const usesRequired = m.requiredPairs !== undefined;
    if (usesRequired && (!Number.isInteger(m.requiredPairs) || m.requiredPairs < 1)) {
      throw new Error("requiredPairs must be a positive integer");
    }
    if (notMeasured(m)) {
      return { name: m.name, aMed: null, bMed: null, effect: "-", t: "-", verdict: "not measured" };
    }
    if (usesRequired) {
      const { kept, dropped } = countingPairs(m);
      if (kept.length < m.requiredPairs) {
        const why = dropped.length ? ` (${dropped.join("; ")})` : "";
        return {
          name: m.name,
          aMed: null,
          bMed: null,
          effect: "-",
          t: "-",
          verdict: `no verdict: ${kept.length} of ${m.requiredPairs} pairs count${why}`,
        };
      }
      m = { ...m, pairs: kept };
    }
    const n = noise(m.kind, m.baselineSamples);
    const t = threshold(m.kind, n, { floor: m.floor });
    const e = effect(m.kind, m.pairs);
    const v = verdict(m.kind, m.pairs, t);
    const aMed = median(m.pairs.map((p) => p.a));
    const bMed = median(m.pairs.map((p) => p.b));
    return {
      name: m.name,
      aMed,
      bMed,
      effect: formatEffect(m.kind, e),
      t: formatEffect(m.kind, t),
      verdict: v,
    };
  });
  const lines = [
    "| metric | A median | B median | effect | T | verdict |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${r.aMed === null ? "-" : formatNumber(r.aMed)} | ${r.bMed === null ? "-" : formatNumber(r.bMed)} | ${r.effect} | ${r.t} | ${r.verdict} |`
    );
  }
  return lines.join("\n");
}

export const ABORT_EXIT_CODE = 3;

/**
 * One abort-table row per metric: noise (band for ratio, spread for
 * absolute), the limit it compares against (20 % for ratio, `cap` for
 * absolute), and whether it is over. Absolute guards with a guard flag need a
 * cap, exactly like abortCheck. Throws on malformed input, like the other
 * exported helpers.
 */
export function abortRows(metrics) {
  if (!Array.isArray(metrics)) {
    throw new Error("abortRows needs an array of metrics");
  }
  return metrics.map((m) => {
    if (m === null || typeof m !== "object") {
      throw new Error("abortRows needs metric objects");
    }
    const name = typeof m.name === "string" && m.name.length > 0 ? m.name : "(unnamed)";
    const exempt = m.abortExempt === true;
    if (notMeasured(m)) {
      return { name, kind: m.kind, noise: null, cap: null, over: false, exempt, notMeasured: true };
    }
    const n = noise(m.kind, m.baselineSamples);
    if (m.kind === "ratio") {
      return {
        name,
        kind: m.kind,
        noise: n,
        cap: ABORT_RATIO_BAND,
        over: n > ABORT_RATIO_BAND,
        exempt,
        notMeasured: false,
        noImprovementPossible: noImprovementPossible(threshold("ratio", n, { floor: m.floor })),
      };
    }
    if (m.kind === "absolute") {
      if (typeof m.cap !== "number" || !Number.isFinite(m.cap) || m.cap < 0) {
        throw new Error("abortRows needs a finite non-negative cap for absolute guards");
      }
      return {
        name,
        kind: m.kind,
        noise: n,
        cap: m.cap,
        over: n > m.cap,
        exempt,
        notMeasured: false,
      };
    }
    throw new Error(`unknown metric kind: ${m.kind}`);
  });
}

/** A1: rows that can stop the experiment (measured and not exempt), as abortCheck input. */
export function abortCheckInput(rows) {
  return rows
    .filter((r) => !r.notMeasured && !r.exempt)
    .map((r) =>
      r.kind === "ratio"
        ? { kind: r.kind, guard: true, noise: r.noise }
        : { kind: r.kind, guard: true, noise: r.noise, cap: r.cap }
    );
}

/**
 * Abort-mode Markdown table: metric, kind, noise, cap or 20 %, over? Pure —
 * the CLI prints it and exits ABORT_EXIT_CODE when abortCheck is true.
 */
export function abortTable(metrics) {
  const rows = abortRows(metrics);
  const lines = ["| metric | kind | noise | cap | over? |", "| --- | --- | --- | --- | --- |"];
  for (const r of rows) {
    if (r.notMeasured) {
      lines.push(`| ${r.name} | ${r.kind} | - | - | not measured |`);
      continue;
    }
    const capText = r.kind === "ratio" ? "20%" : formatNumber(r.cap);
    let over = r.over ? "yes" : "no";
    if (r.exempt) over += " (exempt)";
    // Only exempt rows: a non-exempt band that high aborts anyway, and old rows stay unchanged.
    if (r.exempt && r.noImprovementPossible) over += "; T >= 100 %: no improvement can be shown";
    lines.push(`| ${r.name} | ${r.kind} | ${formatNumber(r.noise)} | ${capText} | ${over} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, second] = process.argv.slice(2);
  if (first === "--abort") {
    if (!second) {
      console.error("usage: node scripts/perf/perf-verdict.mjs --abort <noise.json>");
      process.exit(2);
    }
    try {
      const metrics = readMetrics(second);
      console.log(abortTable(metrics));
      process.exit(abortCheck(abortCheckInput(abortRows(metrics))) ? ABORT_EXIT_CODE : 0);
    } catch (err) {
      console.error(`perf-verdict: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    const file = first;
    if (!file) {
      console.error("usage: node scripts/perf/perf-verdict.mjs <comparison.json>");
      process.exit(2);
    }
    try {
      console.log(verdictTable(readMetrics(file)));
    } catch (err) {
      console.error(`perf-verdict: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}
