// tests/unit/build/check-codeql-ratchet.test.ts
// TDD unit tests for scripts/check/check-codeql-ratchet.mjs — Task 7.3 CodeQL ratchet.
//
// Strategy: test the exported pure function without calling the GitHub API.
// All fixtures are synthetic GitHub API responses.
//   - parseCodeQLAlerts() — filters + counts open, non-dismissed CodeQL alerts
//                           (Hard Rule #14: dismissed alerts do not count)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  parseCodeQLAlerts,
  evaluateCodeqlRatchet,
  missingCodeqlLanguages,
  codeqlRunVerdict,
} from "../../../scripts/check/check-codeql-ratchet.mjs";

type RatchetVerdict = { regressed: boolean; improved: boolean };
const evaluate = evaluateCodeqlRatchet as (current: number, baseline: number) => RatchetVerdict;

// ---------------------------------------------------------------------------
// Fixtures — synthetic GitHub code-scanning/alerts API responses
// ---------------------------------------------------------------------------

/** Helper to build a minimal alert object. */
function makeAlert(
  overrides: {
    number?: number;
    state?: "open" | "dismissed" | "fixed";
    tool?: string;
    ruleId?: string;
    severity?: string;
    securitySeverity?: string;
    dismissedReason?: string | null;
  } = {}
) {
  return {
    number: overrides.number ?? 1,
    state: overrides.state ?? "open",
    dismissed_reason: overrides.dismissedReason ?? null,
    dismissed_at: overrides.dismissedReason ? "2026-01-01T00:00:00Z" : null,
    tool: {
      name: overrides.tool ?? "CodeQL",
      guid: null,
      version: "2.16.0",
    },
    rule: {
      id: overrides.ruleId ?? "js/sql-injection",
      name: overrides.ruleId ?? "SQL Injection",
      severity: overrides.severity ?? "error",
      security_severity_level: overrides.securitySeverity ?? "high",
      description: "Vulnerability description",
    },
    most_recent_instance: {
      ref: "refs/heads/main",
      state: overrides.state ?? "open",
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    url: "https://api.github.com/repos/owner/repo/code-scanning/alerts/1",
    html_url: "https://github.com/owner/repo/security/code-scanning/1",
  };
}

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — input inválido
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: null retorna alertCount=0", () => {
  const result = parseCodeQLAlerts(null);
  assert.equal(result.alertCount, 0);
  assert.deepEqual(result.bySeverity, {});
  assert.deepEqual(result.byRule, {});
});

test("parseCodeQLAlerts: undefined retorna alertCount=0", () => {
  const result = parseCodeQLAlerts(undefined as unknown as null);
  assert.equal(result.alertCount, 0);
});

test("parseCodeQLAlerts: objeto (não-array) retorna alertCount=0", () => {
  const result = parseCodeQLAlerts({ number: 1, state: "open" } as unknown as null);
  assert.equal(result.alertCount, 0);
});

test("parseCodeQLAlerts: string retorna alertCount=0", () => {
  const result = parseCodeQLAlerts("open" as unknown as null);
  assert.equal(result.alertCount, 0);
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — array vazio
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: array vazio retorna alertCount=0", () => {
  const result = parseCodeQLAlerts([]);
  assert.equal(result.alertCount, 0);
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — Hard Rule #14: dismissed alerts don't count
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: alerta dismissed NÃO conta (Hard Rule #14)", () => {
  const alerts = [makeAlert({ state: "dismissed", dismissedReason: "false positive" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 0, "dismissed alert must not be counted");
});

test("parseCodeQLAlerts: alerta dismissed com razão 'used in tests' NÃO conta", () => {
  const alerts = [makeAlert({ state: "dismissed", dismissedReason: "used in tests" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 0);
});

test("parseCodeQLAlerts: alerta dismissed independente da razão NÃO conta", () => {
  const alerts = [
    makeAlert({ state: "dismissed", dismissedReason: "wont fix" }),
    makeAlert({ number: 2, state: "dismissed", dismissedReason: "false positive" }),
    makeAlert({ number: 3, state: "dismissed", dismissedReason: "used in tests" }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 0, "all dismissed states must be excluded");
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — estado fixed não conta
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: alerta fixed NÃO conta", () => {
  const alerts = [makeAlert({ state: "fixed" as "open" | "dismissed" | "fixed" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 0, "fixed alerts are not open, must not count");
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — somente alertas CodeQL (filtra outras ferramentas)
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: alertas de outras ferramentas são ignorados", () => {
  const alerts = [
    makeAlert({ tool: "Semgrep", ruleId: "semgrep-rule-1" }),
    makeAlert({ number: 2, tool: "ESLint", ruleId: "eslint-rule-1" }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 0, "only CodeQL alerts should be counted");
});

test("parseCodeQLAlerts: tool 'CodeQL' (maiúsculas) conta", () => {
  const alerts = [makeAlert({ tool: "CodeQL" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
});

test("parseCodeQLAlerts: tool 'codeql' (minúsculas) conta (case-insensitive)", () => {
  const alerts = [makeAlert({ tool: "codeql" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
});

test("parseCodeQLAlerts: tool 'CodeQL Community' também conta (contém 'codeql')", () => {
  const alerts = [makeAlert({ tool: "CodeQL Community" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — contagem de alertas open
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: 1 alerta open CodeQL retorna alertCount=1", () => {
  const alerts = [makeAlert({ state: "open" })];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
});

test("parseCodeQLAlerts: 3 alertas open retorna alertCount=3", () => {
  const alerts = [
    makeAlert({ number: 1, state: "open" }),
    makeAlert({ number: 2, state: "open", ruleId: "js/xss" }),
    makeAlert({ number: 3, state: "open", ruleId: "js/path-injection" }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 3);
});

test("parseCodeQLAlerts: mix de open, dismissed, fixed — conta só open", () => {
  const alerts = [
    makeAlert({ number: 1, state: "open" }),
    makeAlert({ number: 2, state: "dismissed", dismissedReason: "false positive" }),
    makeAlert({ number: 3, state: "fixed" as "open" | "dismissed" | "fixed" }),
    makeAlert({ number: 4, state: "open", ruleId: "js/xss" }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 2, "only 2 open, non-dismissed alerts");
});

test("parseCodeQLAlerts: mix de CodeQL e outras ferramentas — conta só CodeQL", () => {
  const alerts = [
    makeAlert({ number: 1, tool: "CodeQL", state: "open" }),
    makeAlert({ number: 2, tool: "Semgrep", state: "open" }),
    makeAlert({ number: 3, tool: "CodeQL", state: "open", ruleId: "js/xss" }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 2, "only CodeQL open alerts");
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — severidade
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: coleta bySeverity de security_severity_level", () => {
  const alerts = [
    makeAlert({ number: 1, securitySeverity: "critical" }),
    makeAlert({ number: 2, securitySeverity: "high" }),
    makeAlert({ number: 3, securitySeverity: "medium" }),
    makeAlert({ number: 4, securitySeverity: "high" }), // segundo high
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 4);
  assert.equal(result.bySeverity["critical"], 1);
  assert.equal(result.bySeverity["high"], 2);
  assert.equal(result.bySeverity["medium"], 1);
});

test("parseCodeQLAlerts: alerta sem security_severity_level usa rule.severity", () => {
  const alerts = [
    {
      ...makeAlert({ number: 1 }),
      rule: {
        id: "js/unused-local-variable",
        name: "Unused variable",
        severity: "warning",
        // sem security_severity_level
        description: "Local var not used",
      },
    },
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
  assert.ok(
    "warning" in result.bySeverity || "unknown" in result.bySeverity,
    "severity should be captured"
  );
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — byRule
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: agrupa por rule.id em byRule", () => {
  const alerts = [
    makeAlert({ number: 1, ruleId: "js/sql-injection" }),
    makeAlert({ number: 2, ruleId: "js/xss" }),
    makeAlert({ number: 3, ruleId: "js/sql-injection" }), // segundo do mesmo rule
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.byRule["js/sql-injection"], 2);
  assert.equal(result.byRule["js/xss"], 1);
});

test("parseCodeQLAlerts: alerta sem rule retorna byRule com 'unknown'", () => {
  const alert = {
    number: 1,
    state: "open",
    dismissed_reason: null,
    dismissed_at: null,
    tool: { name: "CodeQL", guid: null, version: "2.16.0" },
    // sem rule
  };
  const result = parseCodeQLAlerts([alert]);
  assert.equal(result.alertCount, 1);
  assert.ok("unknown" in result.byRule);
});

// ---------------------------------------------------------------------------
// parseCodeQLAlerts — dismissed não contamina contagens
// ---------------------------------------------------------------------------

test("parseCodeQLAlerts: dismissed com mesmo ruleId que open — dismissed não aparece em byRule", () => {
  const alerts = [
    makeAlert({ number: 1, state: "open", ruleId: "js/sql-injection" }),
    makeAlert({
      number: 2,
      state: "dismissed",
      ruleId: "js/sql-injection",
      dismissedReason: "false positive",
    }),
  ];
  const result = parseCodeQLAlerts(alerts);
  assert.equal(result.alertCount, 1);
  assert.equal(result.byRule["js/sql-injection"], 1, "only the open alert should appear in byRule");
});

// ---------------------------------------------------------------------------
// evaluateCodeqlRatchet — ratchet direction:down (Task 7.3 promote to blocking)
// Mirror of evaluateDeadCode: regression when measured > baseline; the baseline
// is 0 (clean), so ANY open CodeQL alert is a regression that blocks.
// ---------------------------------------------------------------------------

test("evaluateCodeqlRatchet: equal to baseline passes (0 vs 0 — clean)", () => {
  const r = evaluate(0, 0);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, false);
});

test("evaluateCodeqlRatchet: one more alert than baseline 0 is a regression", () => {
  const r = evaluate(1, 0);
  assert.equal(r.regressed, true, "a single new open CodeQL alert must block");
  assert.equal(r.improved, false);
});

test("evaluateCodeqlRatchet: fewer alerts than a non-zero baseline is an improvement", () => {
  const r = evaluate(2, 5);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, true);
});

test("evaluateCodeqlRatchet: zero alerts against a non-zero baseline is a maximum improvement", () => {
  const r = evaluate(0, 5);
  assert.equal(r.regressed, false);
  assert.equal(r.improved, true);
});

test("evaluateCodeqlRatchet: strict integer comparison — any increase regresses", () => {
  assert.equal(evaluate(6, 5).regressed, true);
  assert.equal(evaluate(5, 5).regressed, false);
  assert.equal(evaluate(4, 5).regressed, false);
});

// ---------------------------------------------------------------------------
// --require-measurement (the fork's CI mode), driven through a fake `gh` on PATH
// ---------------------------------------------------------------------------

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/check/check-codeql-ratchet.mjs", import.meta.url)
);

function runWithFakeGh(
  {
    alerts,
    analyses,
    baseline = { metrics: { codeqlAlerts: { value: 5 } } },
    runs = OK_RUNS,
  }: {
    alerts: string;
    analyses: string;
    baseline?: unknown;
    runs?: string;
  },
  args: string[]
) {
  const dir = mkdtempSync(join(tmpdir(), "codeql-ratchet-"));
  try {
    writeFileSync(join(dir, "alerts.json"), alerts);
    writeFileSync(join(dir, "analyses.json"), analyses);
    writeFileSync(join(dir, "runs.json"), runs);
    writeFileSync(
      join(dir, "workflows.json"),
      JSON.stringify({ workflows: [{ id: 7, path: "dynamic/github-code-scanning/codeql" }] })
    );
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(baselinePath, typeof baseline === "string" ? baseline : JSON.stringify(baseline));
    // Answers `gh repo view` and the two `gh api` endpoints from the fixture files.
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        'if [ "$1" = repo ]; then echo owner/repo; exit 0; fi',
        'echo "$2" >> "$FAKE_DIR/calls.log"',
        'case "$2" in',
        '  /repos/owner/repo) echo \'{"default_branch":"main"}\';;',
        '  */actions/workflows/7/runs*) cat "$FAKE_DIR/runs.json";;',
        '  */actions/workflows*) cat "$FAKE_DIR/workflows.json";;',
        '  *analyses*) cat "$FAKE_DIR/analyses.json";;',
        '  *alerts*) cat "$FAKE_DIR/alerts.json";;',
        "esac",
        "",
      ].join("\n")
    );
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "calls.log"), "");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--quiet", "--baseline", baselinePath, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FAKE_DIR: dir,
          GITHUB_REPOSITORY: "owner/repo",
        },
        timeout: 20_000,
      }
    );
    const calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MAIN = "refs/heads/main";
const analysis = (language: string, extra: Record<string, unknown> = {}) => ({
  ref: MAIN,
  category: `/language:${language}`,
  created_at: "2026-11-24T09:52:00Z",
  error: "",
  ...extra,
});
const run = (id: number, created_at: string, conclusion: string) => ({
  id,
  created_at,
  status: "completed",
  conclusion,
});
const OK_RUNS = JSON.stringify({ workflow_runs: [run(1, "2026-11-24T09:51:30Z", "success")] });

test("codeqlRunVerdict: the newest finished run decides, cancelled and skipped runs do not", () => {
  assert.deepEqual(codeqlRunVerdict([run(1, "2026-11-24T09:00:00Z", "success")]), { ok: true });
  assert.equal(
    codeqlRunVerdict([
      run(1, "2026-11-24T09:00:00Z", "success"),
      run(2, "2026-11-24T10:00:00Z", "failure"),
    ]).ok,
    false
  );
  // The newest run cancelled with nothing newer: the newest scan never succeeded.
  assert.equal(
    codeqlRunVerdict([
      run(2, "2026-11-24T10:00:00Z", "cancelled"),
      run(1, "2026-11-24T09:00:00Z", "success"),
    ]).ok,
    false
  );
  // Superseded: a newer run is in progress, so the cancelled one is passed over.
  assert.equal(
    codeqlRunVerdict([
      { id: 3, created_at: "2026-11-24T11:00:00Z", status: "in_progress", conclusion: null },
      run(2, "2026-11-24T10:00:00Z", "cancelled"),
      run(1, "2026-11-24T09:00:00Z", "success"),
    ]).ok,
    true
  );
  assert.equal(codeqlRunVerdict([]).ok, false);
  assert.equal(codeqlRunVerdict(undefined).ok, false);
  // A malformed entry beside a success fails the measurement.
  for (const bad of [null, 7, "x", []]) {
    assert.equal(
      codeqlRunVerdict([run(1, "2026-11-24T09:00:00Z", "success"), bad]).ok,
      false,
      JSON.stringify(bad)
    );
  }
  // A pending and a cancelled run with the same newest time: nothing newer supersedes the
  // cancellation, in either order.
  const pending = { id: 3, created_at: "2026-11-24T10:00:00Z", status: "queued", conclusion: null };
  const cancelled = run(2, "2026-11-24T10:00:00Z", "cancelled");
  const older = run(1, "2026-11-24T09:00:00Z", "success");
  assert.equal(codeqlRunVerdict([pending, cancelled, older]).ok, false);
  assert.equal(codeqlRunVerdict([cancelled, pending, older]).ok, false);
  // Equal timestamps: a failure listed after a success still decides.
  assert.equal(
    codeqlRunVerdict([
      run(1, "2026-11-24T09:00:00Z", "success"),
      run(2, "2026-11-24T09:00:00Z", "failure"),
    ]).ok,
    false
  );
  // A run without a valid created_at cannot be ordered, so the verdict fails closed.
  assert.equal(
    codeqlRunVerdict([
      { id: 2, created_at: ["2026-11-24T10:00:00Z"], status: "completed", conclusion: "success" },
    ]).ok,
    false
  );
  assert.equal(
    codeqlRunVerdict([
      run(1, "2026-11-24T09:00:00Z", "success"),
      { id: 2, created_at: "not a date", status: "completed", conclusion: "failure" },
    ]).ok,
    false
  );
  // A conclusion that contradicts the status fails: pending with a conclusion, completed
  // without a known one.
  for (const bad of [
    { status: "in_progress", conclusion: "failure" },
    { status: "in_progress" },
    { status: "completed", conclusion: null },
    { status: "completed", conclusion: "mystery" },
  ]) {
    assert.equal(
      codeqlRunVerdict([
        { id: 3, created_at: "2026-11-24T11:00:00Z", ...bad },
        run(1, "2026-11-24T09:00:00Z", "success"),
      ]).ok,
      false,
      JSON.stringify(bad)
    );
  }
  // A malformed status on an OLDER record still fails: every record is validated first.
  assert.equal(
    codeqlRunVerdict([
      run(2, "2026-11-24T11:00:00Z", "success"),
      { id: 1, created_at: "2026-11-24T09:00:00Z", status: "mystery", conclusion: null },
    ]).ok,
    false
  );
  // A newest run with a missing or unknown status fails instead of being taken as pending.
  for (const status of [undefined, "mystery"]) {
    assert.equal(
      codeqlRunVerdict([
        { id: 3, created_at: "2026-11-24T11:00:00Z", status, conclusion: null },
        run(1, "2026-11-24T09:00:00Z", "success"),
      ]).ok,
      false,
      String(status)
    );
  }
});

const OK_ANALYSIS = JSON.stringify([
  analysis("javascript-typescript"),
  analysis("actions"),
  analysis("python"),
]);

test("missingCodeqlLanguages needs a successful default-branch analysis per language", () => {
  const all = ["javascript-typescript", "actions", "python"];
  assert.deepEqual(missingCodeqlLanguages(JSON.parse(OK_ANALYSIS), MAIN), []);
  assert.deepEqual(missingCodeqlLanguages({ message: "no analysis found" }, MAIN), all);
  assert.deepEqual(
    missingCodeqlLanguages(
      [
        analysis("javascript-typescript", { error: "failed" }),
        analysis("javascript-typescript", { ref: "refs/pull/10/merge" }),
        analysis("actions"),
        analysis("python"),
      ],
      MAIN
    ),
    ["javascript-typescript"]
  );
});

test("missingCodeqlLanguages judges each language by its newest analysis on the ref", () => {
  const at = (language: string, created_at: string, error = "") =>
    analysis(language, { created_at, error });
  const rest = [analysis("actions"), analysis("python")];
  // A newer failed scan is not covered by an older success.
  assert.deepEqual(
    missingCodeqlLanguages(
      [
        at("javascript-typescript", "2026-11-24T09:00:00Z"),
        at("javascript-typescript", "2026-11-24T10:00:00Z", "failed"),
        ...rest,
      ],
      MAIN
    ),
    ["javascript-typescript"]
  );
  // A malformed entry beside successful analyses fails every language.
  for (const bad of [
    null,
    7,
    "x",
    [],
    { error: "" },
    { ref: MAIN, error: "", category: "custom" },
    { ref: MAIN, category: "/language:python" },
    { ref: MAIN, error: "", category: ["/language:python"] },
  ]) {
    assert.deepEqual(
      missingCodeqlLanguages([...JSON.parse(OK_ANALYSIS), bad], MAIN),
      ["javascript-typescript", "actions", "python"],
      JSON.stringify(bad)
    );
  }
  // An analysis without a valid created_at cannot be ordered: its language fails closed.
  assert.deepEqual(
    missingCodeqlLanguages(
      [
        at("javascript-typescript", "2026-11-24T10:00:00Z"),
        at("javascript-typescript", "", "failed"),
        analysis("javascript-typescript", { created_at: ["2026-11-24T11:00:00Z"] }),
        ...rest,
      ],
      MAIN
    ),
    ["javascript-typescript"]
  );
  // A newer success replaces an older failure, whatever order the API lists them in.
  assert.deepEqual(
    missingCodeqlLanguages(
      [
        at("javascript-typescript", "2026-11-24T10:00:00Z"),
        at("javascript-typescript", "2026-11-24T09:00:00Z", "failed"),
        ...rest,
      ],
      MAIN
    ),
    []
  );
});

test("require-measurement: a scan that failed before uploading fails despite older analyses", () => {
  const runs = JSON.stringify({
    workflow_runs: [
      run(2, "2026-11-24T11:00:00Z", "failure"),
      run(1, "2026-11-24T09:51:30Z", "success"),
    ],
  });
  const result = runWithFakeGh({ alerts: "[]", analyses: OK_ANALYSIS, runs }, [
    "--require-measurement",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run 2 ended failure/);
  assert.deepEqual(
    result.calls.filter((call) => /alerts/.test(call)),
    []
  );
});

test("require-measurement: actions and python alone (JS/TS still running) fail", () => {
  const fixture = {
    alerts: "[]",
    analyses: JSON.stringify([analysis("actions"), analysis("python")]),
  };
  const result = runWithFakeGh(fixture, ["--require-measurement"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /javascript-typescript/);
});

test("require-measurement: no CodeQL analysis fails, plain mode passes", () => {
  const fixture = { alerts: "[]", analyses: "[]" };
  assert.equal(runWithFakeGh(fixture, ["--require-measurement"]).status, 1);
  assert.equal(runWithFakeGh(fixture, []).status, 0);
});

test("require-measurement: only failed analyses still fail", () => {
  const fixture = {
    alerts: "[]",
    analyses: JSON.stringify(JSON.parse(OK_ANALYSIS).map((a: object) => ({ ...a, error: "boom" }))),
  };
  assert.equal(runWithFakeGh(fixture, ["--require-measurement"]).status, 1);
});

test("require-measurement: a usable analysis and alerts within the baseline pass", () => {
  const result = runWithFakeGh({ alerts: "[]", analyses: OK_ANALYSIS }, ["--require-measurement"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codeqlAlerts=0/);
});

test("require-measurement: the analysis check runs before the alerts are read", () => {
  const { calls } = runWithFakeGh({ alerts: "[]", analyses: OK_ANALYSIS }, [
    "--require-measurement",
  ]);
  const firstAlerts = calls.findIndex((call) => /\/code-scanning\/alerts\?/.test(call));
  const analysesAt = calls.findIndex((call) => /\/code-scanning\/analyses\?/.test(call));
  assert.ok(analysesAt >= 0 && firstAlerts > analysesAt, calls.join());
  assert.ok(
    calls.slice(firstAlerts).every((call) => /\/code-scanning\/alerts\?/.test(call)),
    calls.join()
  );
  assert.ok(calls.length >= 2);
});

test("require-measurement: no analysis means the alerts are never read", () => {
  const { calls, status } = runWithFakeGh({ alerts: "[]", analyses: "[]" }, [
    "--require-measurement",
  ]);
  assert.equal(status, 1);
  assert.deepEqual(
    calls.filter((call) => /alerts/.test(call)),
    []
  );
});

test("require-measurement: a non-array alerts response fails instead of counting zero", () => {
  const fixture = { alerts: '{"message":"oops"}', analyses: OK_ANALYSIS };
  assert.equal(runWithFakeGh(fixture, ["--require-measurement"]).status, 1);
  assert.equal(runWithFakeGh(fixture, []).status, 0);
});

test("require-measurement: alert entries that are not open CodeQL alerts fail the measurement", () => {
  for (const alerts of [
    '[{"number":1}]',
    '[{"state":"open"}]',
    "[null]",
    '[{"state":"open","tool":{"name":["CodeQL"]}}]',
  ]) {
    const result = runWithFakeGh({ alerts, analyses: OK_ANALYSIS }, ["--require-measurement"]);
    assert.equal(result.status, 1, alerts);
  }
  // A wrongly typed severity is a controlled failure, not a crash.
  const badSeverity = JSON.stringify([
    { state: "open", tool: { name: "CodeQL" }, rule: { security_severity_level: ["high"] } },
  ]);
  const crashed = runWithFakeGh({ alerts: badSeverity, analyses: OK_ANALYSIS }, [
    "--require-measurement",
  ]);
  assert.equal(crashed.status, 1);
  assert.match(crashed.stdout, /reason=unexpected-shape/);
  assert.doesNotMatch(crashed.stderr, /TypeError/);
  const real = JSON.stringify([{ number: 1, state: "open", tool: { name: "CodeQL" } }]);
  const result = runWithFakeGh({ alerts: real, analyses: OK_ANALYSIS }, ["--require-measurement"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codeqlAlerts=1/);
});

test("require-measurement: a missing or malformed baseline fails", () => {
  for (const baseline of [
    "{not json",
    { metrics: {} },
    { metrics: { codeqlAlerts: { value: "5" } } },
  ]) {
    const result = runWithFakeGh({ alerts: "[]", analyses: OK_ANALYSIS, baseline }, [
      "--require-measurement",
    ]);
    assert.equal(result.status, 1, JSON.stringify(baseline));
  }
});

test("ci.yml runs the CodeQL ratchet with --require-measurement", () => {
  const ci = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
    "utf8"
  );
  assert.match(ci, /pnpm run check:codeql-ratchet --require-measurement/);
});
