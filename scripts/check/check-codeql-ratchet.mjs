#!/usr/bin/env node
// scripts/check/check-codeql-ratchet.mjs
// Catraca de alertas CodeQL (Task 7.3 — Fase 7).
//
// Usa a GitHub API via `gh` CLI para buscar alertas de code-scanning abertos e
// não-dismissed (respeita Hard Rule #14: alertas dismissed não contam).
//
// Saída (stdout):
//   codeqlAlerts=N        — contagem de alertas CodeQL abertos, não-dismissed
//   codeqlAlerts=SKIP reason=binary-absent   — `gh` não está no PATH
//   codeqlAlerts=SKIP reason=no-auth         — `gh` presente mas sem autenticação
//   codeqlAlerts=SKIP reason=api-error:<code>  — erro da API GitHub
//
// RATCHET BLOQUEANTE (default): lê metrics.codeqlAlerts.value de
// config/quality/quality-baseline.json e SAI 1 SE — E SOMENTE SE — a contagem
// MEDIDA for MAIOR que o baseline (regressão real, mais alertas CodeQL abertos).
// Qualquer falha de MEDIÇÃO (gh ausente / sem auth / sem repo / erro de API) é um
// SKIP que SAI 0 — salvo com --require-measurement (CI do fork), que sai 1 nesses casos,
// num repositório sem análise CodeQL e com baseline ausente ou inválido.
// Direction: down (a contagem só pode CAIR). Suporta --update para ratchetar.
//
// Uso:
//   node scripts/check/check-codeql-ratchet.mjs
//   node scripts/check/check-codeql-ratchet.mjs --json    # imprime array de alertas
//   node scripts/check/check-codeql-ratchet.mjs --quiet   # suprime logs de diagnóstico
//   node scripts/check/check-codeql-ratchet.mjs --update  # ratcheta o baseline (queda)
//   node scripts/check/check-codeql-ratchet.mjs --advisory  # nunca falha (modo coletor)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const QUIET = process.argv.includes("--quiet");
const PRINT_JSON = process.argv.includes("--json");
const UPDATE = process.argv.includes("--update");
// --advisory: nunca falha pela contagem (modo coletor legado). Sem esta flag o
// gate é BLOQUEANTE: sai 1 numa regressão real (medida > baseline).
const ADVISORY = process.argv.includes("--advisory");
// --require-measurement (CI): a SKIP (no gh, no repo, API or parse error) and a repository
// with no CodeQL analysis at all exit 1, because an empty alert list then measures nothing.
const REQUIRE_MEASUREMENT = process.argv.includes("--require-measurement");

const ROOT = process.cwd();
const BASELINE_PATH = path.resolve(
  process.argv.includes("--baseline")
    ? process.argv[process.argv.indexOf("--baseline") + 1]
    : path.join(ROOT, "config/quality/quality-baseline.json")
);

// ---------------------------------------------------------------------------
// Pure parsing function (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Conta alertas CodeQL abertos e não-dismissed a partir do JSON da GitHub API.
 *
 * A GitHub API /code-scanning/alerts retorna um array de:
 * {
 *   number: number,
 *   state: "open" | "dismissed" | "fixed",
 *   dismissed_reason: string | null,
 *   dismissed_at: string | null,
 *   tool: { name: string, ... },
 *   rule: { id: string, severity: string, security_severity_level?: string, ... },
 *   ...
 * }
 *
 * Hard Rule #14: alertas com `state="dismissed"` NÃO contam, independente da razão.
 * Filtramos por state="open" E tool.name contendo "CodeQL" (case-insensitive).
 * Alertas de outras ferramentas (ex: Semgrep) são ignorados.
 *
 * @param {Array|null} alerts - Array de alertas da API GitHub
 * @returns {{ alertCount: number, bySeverity: Record<string, number>, byRule: Record<string, number> }}
 */
export function parseCodeQLAlerts(alerts) {
  if (!Array.isArray(alerts)) {
    return { alertCount: 0, bySeverity: {}, byRule: {} };
  }

  let alertCount = 0;
  const bySeverity = {};
  const byRule = {};

  for (const alert of alerts) {
    // Ignorar alertas não-CodeQL (outras ferramentas de code scanning)
    const toolName = alert?.tool?.name ?? "";
    if (!toolName.toLowerCase().includes("codeql")) continue;

    // Hard Rule #14: alertas dismissed não contam
    if (alert.state === "dismissed") continue;

    // Só alertas abertos
    if (alert.state !== "open") continue;

    alertCount++;

    // Coletar por severidade (security_severity_level ou severity da rule)
    const severity = (
      alert?.rule?.security_severity_level ??
      alert?.rule?.severity ??
      "unknown"
    ).toLowerCase();
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;

    // Coletar por rule ID
    const ruleId = alert?.rule?.id ?? "unknown";
    byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;
  }

  return { alertCount, bySeverity, byRule };
}

/**
 * Avalia a contagem MEDIDA de alertas CodeQL contra o baseline.
 * Direction: down (a contagem só pode CAIR — mais alertas = regressão).
 *
 * Exported for unit testing — espelha evaluateDeadCode em check-dead-code.mjs.
 *
 * @param {number} current  - Contagem de alertas medida agora.
 * @param {number} baseline - Contagem congelada em quality-baseline.json.
 * @returns {{ regressed: boolean, improved: boolean }}
 */
export function evaluateCodeqlRatchet(current, baseline) {
  return {
    regressed: current > baseline,
    improved: current < baseline,
  };
}

// ---------------------------------------------------------------------------
// Repository detection
// ---------------------------------------------------------------------------

/**
 * Detecta o owner/repo do repositório atual usando `gh repo view`.
 * Retorna null se `gh` não estiver disponível ou não autenticado.
 *
 * @param {string} ghBin - Caminho para o binário gh
 * @returns {string|null} "owner/repo" ou null
 */
export function detectRepo(ghBin) {
  // In Actions, GITHUB_REPOSITORY names the repository under test. `gh repo view` follows the
  // checkout's default remote, which in a fork with an `upstream` remote can be the upstream.
  const fromEnv = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(fromEnv)) return fromEnv;
  try {
    const stdout = execFileSync(
      ghBin,
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      {
        encoding: "utf8",
        timeout: 15_000,
      }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * Detecta se o binário `gh` está disponível no PATH.
 * Usa `which` (Unix) sem interpolação de shell — Hard Rule #13.
 *
 * @returns {string|null} Caminho absoluto para o binário, ou null se ausente.
 */
export function findGhCli() {
  try {
    const result = spawnSync("which", ["gh"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {
    // which não disponível
  }

  // Fallback: tentar executar diretamente para verificar ENOENT
  try {
    const result = spawnSync("gh", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error?.code === "ENOENT") return null;
    if (result.status !== null) return "gh"; // found in PATH
  } catch {
    // noop
  }

  return null;
}

// ---------------------------------------------------------------------------
// API caller
// ---------------------------------------------------------------------------

/**
 * Busca alertas CodeQL abertos via `gh api`.
 * Pagina automaticamente (GitHub retorna max 100 por página).
 *
 * @param {string} ghBin - Caminho para o binário gh
 * @param {string} repo  - "owner/repo"
 * @returns {Array} Array de alertas
 */
function fetchCodeQLAlerts(ghBin, repo) {
  const allAlerts = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const endpoint = `/repos/${repo}/code-scanning/alerts?state=open&tool_name=CodeQL&per_page=${perPage}&page=${page}`;

    if (!QUIET) {
      process.stderr.write(`[codeql-ratchet] Buscando alertas: página ${page} ...\n`);
    }

    let stdout;
    try {
      stdout = execFileSync(ghBin, ["api", endpoint], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      const errMsg = String(err.stderr ?? err.message ?? "");

      // Sem autenticação
      if (
        errMsg.includes("authentication") ||
        errMsg.includes("401") ||
        errMsg.includes("not logged")
      ) {
        return { error: "no-auth", message: errMsg };
      }

      // Rate limit ou outro erro HTTP
      const codeMatch = /HTTP (\d{3})/.exec(errMsg);
      const code = codeMatch ? codeMatch[1] : "unknown";
      return { error: `api-error:${code}`, message: errMsg };
    }

    let page_alerts;
    try {
      page_alerts = JSON.parse(stdout);
    } catch (parseErr) {
      // A malformed (but HTTP-200) API response is a MEASUREMENT failure, not a
      // regression. A blocking gate must never red on it — return the same
      // {error,message} shape the caller already maps to a graceful SKIP (exit 0).
      return { error: "parse-error", message: String(parseErr.message ?? parseErr) };
    }

    // The alerts endpoint always answers an array; anything else is a measurement failure,
    // never "no more pages" (it would turn a bad response into zero or a partial count).
    if (!Array.isArray(page_alerts)) {
      return { error: "unexpected-shape", message: `page ${page} is not an array` };
    }
    // The query asks for open CodeQL alerts, so every entry must say so; anything else would be
    // dropped by parseCodeQLAlerts and undercount.
    const badAlert = page_alerts.find(
      (a) =>
        !a ||
        typeof a !== "object" ||
        Array.isArray(a) ||
        a.state !== "open" ||
        typeof a.tool?.name !== "string" ||
        !/codeql/i.test(a.tool.name)
    );
    if (badAlert !== undefined) {
      return {
        error: "unexpected-shape",
        message: `page ${page} has an alert that is not an open CodeQL alert`,
      };
    }
    if (page_alerts.length === 0) break;

    allAlerts.push(...page_alerts);

    // Se retornou menos que perPage, chegamos à última página
    if (page_alerts.length < perPage) break;

    page++;
  }

  return allAlerts;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Lê metrics.codeqlAlerts.value do quality-baseline.json.
 * Retorna null se o arquivo ou a métrica estiverem ausentes (modo coletor puro:
 * sem baseline não há ratchet, só emissão da contagem).
 *
 * @returns {number|null}
 */
function readBaselineCodeqlValue() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  let baselineJson;
  try {
    baselineJson = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
  const metric = baselineJson?.metrics?.codeqlAlerts;
  if (!metric || typeof metric.value !== "number") return null;
  return metric.value;
}

/**
 * Aplica o ratchet (direction:down) sobre a contagem medida vs o baseline.
 * Define process.exitCode = 1 numa regressão real (medida > baseline) salvo
 * --advisory. Ratcheta o baseline com --update quando a contagem cai.
 *
 * Exported for unit testing (drives o efeito em process.exitCode).
 *
 * @param {number} alertCount - Contagem MEDIDA (medição bem-sucedida).
 */
export function applyRatchet(alertCount) {
  const baselineValue = readBaselineCodeqlValue();

  // Sem baseline → modo coletor puro (emite a contagem, não falha), salvo --require-measurement.
  if (baselineValue === null) {
    if (REQUIRE_MEASUREMENT) {
      finishUnmeasured(true, "metrics.codeqlAlerts baseline missing or invalid");
      return;
    }
    if (!QUIET) {
      process.stderr.write(
        "[codeql-ratchet] baseline ausente (metrics.codeqlAlerts) — modo coletor, sem ratchet.\n"
      );
    }
    process.exitCode = 0;
    return;
  }

  const { regressed, improved } = evaluateCodeqlRatchet(alertCount, baselineValue);

  if (UPDATE && improved) {
    const baselineJson = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    baselineJson.metrics.codeqlAlerts.value = alertCount;
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineJson, null, 2) + "\n");
    console.log(`[codeql-ratchet] baseline ratcheado: ${alertCount} (era ${baselineValue})`);
  }

  if (regressed && !ADVISORY) {
    process.stderr.write(
      `[codeql-ratchet] REGRESSÃO — ${alertCount} alertas CodeQL abertos > baseline ${baselineValue}\n` +
        "  → Corrija os novos alertas em Security → Code scanning, ou rode\n" +
        "    'node scripts/check/check-codeql-ratchet.mjs --update' se a contagem caiu legitimamente.\n"
    );
    process.exitCode = 1;
    return;
  }

  if (!QUIET) {
    const verdict = regressed ? "ADVISORY — regressão ignorada (--advisory)" : "OK — sem regressão";
    process.stderr.write(
      `[codeql-ratchet] ${verdict} — ${alertCount} alertas (baseline ${baselineValue})\n`
    );
  }
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Ends a run that could not measure. Exit 0 by default; exit 1 under --require-measurement.
 *
 * @param {boolean} requireMeasurement
 * @param {string} reason
 * @returns {number} the exit code it set
 */
export function finishUnmeasured(requireMeasurement, reason) {
  if (requireMeasurement) {
    process.stderr.write(
      `[codeql-ratchet] FAIL — no CodeQL measurement (${reason}); --require-measurement is set.\n`
    );
  }
  process.exitCode = requireMeasurement ? 1 : 0;
  return process.exitCode;
}

/**
 * Languages default setup analyzes in this repository. Each needs a successful analysis on the
 * default branch before an alert count means anything: while javascript-typescript (most of the
 * code) is still running, the actions and python results alone would make an empty list look
 * like a measured zero.
 */
export const REQUIRED_CODEQL_LANGUAGES = ["javascript-typescript", "actions", "python"];

/**
 * Returns the required languages whose NEWEST analysis on `ref` is missing or failed. An
 * analysis failed when its `error` is non-empty; its language is the `/language:<name>`
 * category; newest is the latest `created_at`. A scan still running has no record yet, so the
 * previous one stands (Proxy's choice: a pending scan must not turn every PR red), but a failed
 * scan of a newer commit blocks instead of falling back to an older success.
 *
 * @param {unknown} analyses - body of GET /code-scanning/analyses
 * @param {string} ref - e.g. "refs/heads/main"
 * @param {string[]} [required]
 * @returns {string[]}
 */
export function missingCodeqlLanguages(analyses, ref, required = REQUIRED_CODEQL_LANGUAGES) {
  /** @type {Map<string, {time: number, ok: boolean}>} */
  const newest = new Map();
  // An unexpected shape (not an array, or a non-object entry) fails every language.
  // Every entry must be classifiable: string ref and error, and a `/language:<name>` category.
  const malformed =
    !Array.isArray(analyses) ||
    analyses.some(
      (a) =>
        !a ||
        typeof a !== "object" ||
        Array.isArray(a) ||
        typeof a.ref !== "string" ||
        typeof a.error !== "string" ||
        typeof a.category !== "string" ||
        !/^\/language:.+$/.test(a.category)
    );
  if (malformed) return [...required];
  {
    for (const a of analyses) {
      if (a.ref !== ref) continue;
      const match = /^\/language:(.+)$/.exec(String(a.category ?? ""));
      if (!match) continue;
      const parsed = typeof a.created_at === "string" ? Date.parse(a.created_at) : NaN;
      const seen = newest.get(match[1]);
      // A record without a valid created_at cannot be ordered: that language fails closed.
      if (Number.isNaN(parsed) || seen?.time === Infinity) {
        newest.set(match[1], { time: Infinity, ok: false });
        continue;
      }
      const time = parsed;
      // On equal times a failure wins, so ambiguity fails closed.
      if (!seen || time > seen.time || (time === seen.time && a.error !== "")) {
        newest.set(match[1], { time, ok: a.error === "" });
      }
    }
  }
  return required.filter((language) => !newest.get(language)?.ok);
}

function apiError(err) {
  const errMsg = String(err?.stderr ?? err?.message ?? err ?? "");
  const codeMatch = /HTTP (\d{3})/.exec(errMsg);
  return { error: `api-error:${codeMatch ? codeMatch[1] : "unknown"}`, message: errMsg };
}

/**
 * Checks the default branch for a successful analysis of every required language.
 * The alerts endpoint without `ref` lists the default branch's alerts, so this is the ref the
 * count is measured on.
 *
 * @returns {{ref: string, missing: string[]}|{error: string, message: string}}
 */
function checkCodeqlAnalyses(ghBin, repo) {
  let ref;
  try {
    const meta = JSON.parse(
      execFileSync(ghBin, ["api", `/repos/${repo}`], { encoding: "utf8", timeout: 30_000 })
    );
    if (typeof meta?.default_branch !== "string" || !meta.default_branch) {
      return { error: "no-default-branch", message: "repository has no default_branch" };
    }
    ref = `refs/heads/${meta.default_branch}`;
  } catch (err) {
    return apiError(err);
  }
  try {
    const stdout = execFileSync(
      ghBin,
      [
        "api",
        `/repos/${repo}/code-scanning/analyses?tool_name=CodeQL&ref=${encodeURIComponent(ref)}&per_page=100`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    const missing = missingCodeqlLanguages(JSON.parse(stdout), ref);
    if (missing.length > 0) return { ref, missing };
  } catch (err) {
    const errMsg = String(err?.stderr ?? err?.message ?? "");
    // GitHub answers 404 "no analysis found" when code scanning never ran.
    if (/HTTP 404|no analysis found/i.test(errMsg)) {
      return { ref, missing: [...REQUIRED_CODEQL_LANGUAGES] };
    }
    return apiError(err);
  }
  // A scan that fails before uploading leaves no analysis record, so the workflow run is the
  // only place that failure shows. codeqlRunVerdict() has the rules: pending runs are passed
  // over, the newest decisive run must have succeeded.
  try {
    const workflows = JSON.parse(
      execFileSync(ghBin, ["api", `/repos/${repo}/actions/workflows?per_page=100`], {
        encoding: "utf8",
        timeout: 30_000,
      })
    );
    const codeql = (workflows?.workflows ?? []).find((w) => w?.path === CODEQL_SETUP_PATH);
    if (!codeql) {
      return { error: "no-codeql-workflow", message: `no ${CODEQL_SETUP_PATH} workflow` };
    }
    const branch = ref.slice("refs/heads/".length);
    const runs = JSON.parse(
      execFileSync(
        ghBin,
        [
          "api",
          `/repos/${repo}/actions/workflows/${codeql.id}/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
        ],
        { encoding: "utf8", timeout: 30_000 }
      )
    );
    const verdict = codeqlRunVerdict(runs?.workflow_runs);
    if (!verdict.ok) return { ref, missing: [], runFailure: verdict.reason };
  } catch (err) {
    return apiError(err);
  }
  return { ref, missing: [] };
}

const CODEQL_SETUP_PATH = "dynamic/github-code-scanning/codeql";

/**
 * Judges the CodeQL default-setup runs on the branch, newest first. A run still queued or in
 * progress is passed over (the previous results stand). A cancelled or skipped run is passed
 * over only when a newer run exists (it was superseded); as the newest run it fails. The first
 * other finished run decides: success passes, anything else fails.
 *
 * @param {unknown} runs - `workflow_runs` from GET /actions/workflows/{id}/runs
 * @returns {{ok: boolean, reason?: string}}
 */
// Workflow-run statuses that mean "not finished yet" (GitHub Actions API).
const PENDING_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

// Conclusions a completed workflow run can have (GitHub Actions API).
const RUN_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
]);

export function codeqlRunVerdict(runs) {
  if (!Array.isArray(runs)) return { ok: false, reason: "runs response is not an array" };
  if (runs.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
    return { ok: false, reason: "runs response has a non-object entry" };
  }
  const records = [...runs];
  // Runs that cannot be ordered make "newest" unknowable, so the check fails closed.
  const unordered = records.find(
    (r) => typeof r.created_at !== "string" || Number.isNaN(Date.parse(r.created_at))
  );
  if (unordered) {
    return { ok: false, reason: `CodeQL run ${unordered.id} has no valid created_at` };
  }
  // Validate every status before deciding, so a decisive newer run cannot hide a malformed
  // older record. A missing or unknown status is a measurement failure, not a pending run.
  // The conclusion must fit the status: null while pending, a known value once completed.
  const inconsistent = records.find((r) =>
    PENDING_RUN_STATUSES.has(r.status)
      ? r.conclusion !== null
      : r.status !== "completed" || !RUN_CONCLUSIONS.has(r.conclusion)
  );
  if (inconsistent) {
    return {
      ok: false,
      reason: `CodeQL run ${inconsistent.id} has status ${inconsistent.status} with conclusion ${inconsistent.conclusion}`,
    };
  }
  // Newest first; on equal times a success sorts last, so a tie never hides a failure.
  const isSuccess = (r) => r.status === "completed" && r.conclusion === "success";
  const sorted = records.sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      Number(isSuccess(a)) - Number(isSuccess(b))
  );
  for (const r of sorted) {
    if (PENDING_RUN_STATUSES.has(r.status)) continue;
    if (["cancelled", "skipped"].includes(r.conclusion)) {
      // Superseded only by a strictly newer run; a run with the same time proves nothing.
      const time = Date.parse(r.created_at);
      if (!sorted.some((other) => Date.parse(other.created_at) > time)) {
        return { ok: false, reason: `newest CodeQL run ${r.id} was ${r.conclusion}` };
      }
      continue;
    }
    return r.conclusion === "success"
      ? { ok: true }
      : { ok: false, reason: `newest CodeQL run ${r.id} ended ${r.conclusion}` };
  }
  return { ok: false, reason: "no finished CodeQL run" };
}

function main() {
  const ghBin = findGhCli();

  if (!ghBin) {
    console.log("codeqlAlerts=SKIP reason=binary-absent");
    if (!QUIET) {
      process.stderr.write(
        "[codeql-ratchet] SKIP — `gh` CLI não encontrado no PATH.\n" +
          "[codeql-ratchet] Instale via: https://cli.github.com/\n"
      );
    }
    finishUnmeasured(REQUIRE_MEASUREMENT, "binary-absent");
    return;
  }

  // Detectar repositório
  const repo = detectRepo(ghBin);
  if (!repo) {
    console.log("codeqlAlerts=SKIP reason=no-repo");
    if (!QUIET) {
      process.stderr.write(
        "[codeql-ratchet] SKIP — não foi possível detectar o repositório GitHub.\n" +
          "[codeql-ratchet] Execute dentro de um repositório GitHub com `gh` autenticado.\n"
      );
    }
    finishUnmeasured(REQUIRE_MEASUREMENT, "no-repo");
    return;
  }

  if (!QUIET) {
    process.stderr.write(`[codeql-ratchet] Repositório detectado: ${repo}\n`);
  }

  // Confirm a successful analysis BEFORE reading alerts: read the other way round, an analysis
  // finishing between the two requests would let a pre-analysis empty list pass as zero.
  if (REQUIRE_MEASUREMENT) {
    const analyses = checkCodeqlAnalyses(ghBin, repo);
    if ("error" in analyses) {
      console.log(`codeqlAlerts=SKIP reason=${analyses.error}`);
      finishUnmeasured(true, analyses.error);
      return;
    }
    if (analyses.runFailure) {
      console.log("codeqlAlerts=SKIP reason=codeql-run-failed");
      finishUnmeasured(true, analyses.runFailure);
      return;
    }
    if (analyses.missing.length > 0) {
      console.log("codeqlAlerts=SKIP reason=no-analysis");
      finishUnmeasured(
        true,
        `no successful CodeQL analysis on ${analyses.ref} for ${analyses.missing.join(", ")}`
      );
      return;
    }
  }

  // Buscar alertas
  const result = fetchCodeQLAlerts(ghBin, repo);

  // Tratar erros da API com skip gracioso
  if (!Array.isArray(result)) {
    const { error, message } = result;
    console.log(`codeqlAlerts=SKIP reason=${error}`);
    if (!QUIET) {
      process.stderr.write(
        `[codeql-ratchet] SKIP — erro ao consultar API GitHub: ${message.slice(0, 200)}\n`
      );
    }
    finishUnmeasured(REQUIRE_MEASUREMENT, error);
    return;
  }

  if (PRINT_JSON) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // Any field of an unexpected type is a measurement failure, reported like the others rather
  // than as a crash.
  let parsed;
  try {
    parsed = parseCodeQLAlerts(result);
  } catch (err) {
    console.log("codeqlAlerts=SKIP reason=unexpected-shape");
    finishUnmeasured(REQUIRE_MEASUREMENT, `alert parse failed: ${String(err?.message ?? err)}`);
    return;
  }
  const { alertCount, bySeverity, byRule } = parsed;

  // Emitir em formato KEY=VALUE para o coletor de métricas (collect-metrics.mjs)
  console.log(`codeqlAlerts=${alertCount}`);

  if (!QUIET) {
    const severitySummary =
      Object.entries(bySeverity)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "nenhum";
    const topRules =
      Object.entries(byRule)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([r, n]) => `${r}(${n})`)
        .join(", ") || "nenhum";

    process.stderr.write(
      `[codeql-ratchet] Alertas CodeQL abertos (não-dismissed): ${alertCount}\n`
    );
    if (alertCount > 0) {
      process.stderr.write(`[codeql-ratchet]   Por severidade: ${severitySummary}\n`);
      process.stderr.write(`[codeql-ratchet]   Top regras: ${topRules}\n`);
    }
  }

  // Medição bem-sucedida → aplica o ratchet (bloqueante salvo --advisory).
  // Qualquer falha de MEDIÇÃO acima já retornou (exit 0, ou 1 com --require-measurement).
  applyRatchet(alertCount);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
