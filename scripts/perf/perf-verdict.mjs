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

export function verdictTable(metrics) {
  const rows = metrics.map((m) => {
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
      `| ${r.name} | ${formatNumber(r.aMed)} | ${formatNumber(r.bMed)} | ${r.effect} | ${r.t} | ${r.verdict} |`
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
    const n = noise(m.kind, m.baselineSamples);
    if (m.kind === "ratio") {
      return {
        name,
        kind: m.kind,
        noise: n,
        cap: ABORT_RATIO_BAND,
        over: n > ABORT_RATIO_BAND,
      };
    }
    if (m.kind === "absolute") {
      if (typeof m.cap !== "number" || !Number.isFinite(m.cap) || m.cap < 0) {
        throw new Error("abortRows needs a finite non-negative cap for absolute guards");
      }
      return { name, kind: m.kind, noise: n, cap: m.cap, over: n > m.cap };
    }
    throw new Error(`unknown metric kind: ${m.kind}`);
  });
}

/**
 * Abort-mode Markdown table: metric, kind, noise, cap or 20 %, over? Pure —
 * the CLI prints it and exits ABORT_EXIT_CODE when abortCheck is true.
 */
export function abortTable(metrics) {
  const rows = abortRows(metrics);
  const lines = ["| metric | kind | noise | cap | over? |", "| --- | --- | --- | --- | --- |"];
  for (const r of rows) {
    const capText = r.kind === "ratio" ? "20%" : formatNumber(r.cap);
    lines.push(
      `| ${r.name} | ${r.kind} | ${formatNumber(r.noise)} | ${capText} | ${r.over ? "yes" : "no"} |`
    );
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
      const checkInput = abortRows(metrics).map((r) =>
        r.kind === "ratio"
          ? { kind: r.kind, guard: true, noise: r.noise }
          : { kind: r.kind, guard: true, noise: r.noise, cap: r.cap }
      );
      process.exit(abortCheck(checkInput) ? ABORT_EXIT_CODE : 0);
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
