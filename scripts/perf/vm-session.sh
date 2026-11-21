#!/usr/bin/env bash
# Slimming perf experiment: one VM session (step 10, one step-11 fix, or step 12).
#
# Runs the session in the approved plan (_tasks/.../2026-11-16-slimming-perf-experiment.md) and
# enforces its limits: load gate (wait-idle.sh, 30 min per session), per-part timeouts (25 %
# over the upper estimate), a status check of every report, rerun caps (1 build, 1 suite part,
# 2 benchmark/probe per session; one rerun per run), and a check for leftover servers before
# each run. Every run gets a fixed, pair-indexed label; results are written to $OUT.
#
# Run it as the measuring account (PERF_RUNNER, default `runner`; never `user`, which boat's
# agent and tunnel use). Start it detached so an ssh drop does not kill it:
#   export PERF_OUT=~/perf/<date>-step10; mkdir -p "$PERF_OUT"
#   nohup setsid bash ~/omniroute/scripts/perf/vm-session.sh step10 --s0 <sha> > "$PERF_OUT/driver.log" 2>&1 &
# M9b needs the OpenRouter key from a hidden prompt, so it is a separate, interactive call:
#   bash ~/omniroute/scripts/perf/vm-session.sh m9b --out <dir> --root-a ~/arm-a [--root-b ~/arm-b]
#
# Resume after a manual stop or a dropped run: start the same command again with
# PERF_OUT=<the session's $OUT>. An automatic stop ends the session (plan v7, runbook section 0).
# Labels already recorded as ok in $OUT/runs.tsv are skipped; warmups run again.
set -uo pipefail

DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$HOME/omniroute"
BUNDLE="$HOME/omniroute-slimming.bundle"
BASE_URL="https://github.com/misileremielle/omniroute.git"   # public; no credential needed
BASE_BRANCH="ccr-e2b2d281-7x2x25"
ARM_A="$HOME/arm-a"
ARM_B="$HOME/arm-b"
NPM_CACHE="/var/tmp/perf-npm-cache"                           # shared by both arms, not copied off

# Rerun caps per session (plan: Time and cost) and the load-gate total.
MAX_BUILD_RERUNS=1
MAX_SUITE_RERUNS=1
MAX_BENCH_RERUNS=2
MAX_WAIT_TOTAL_S=1800
# Timeouts: 1.25 x the upper estimate of each part.
TO_BUILD=75m        # B <= 1 h (time-build.mjs also stops at 60 min)
TO_BASE=45m         # R <= 0.6 h
TO_PROBE=10m        # P <= 0.1 h, plus the 60 s idle check
TO_SUITE_S=9000     # S <= 2 h for all three parts together -> 150 min total, shared by the parts
# A suite part whose log does not grow for this long is killed (stall-guard.sh, exit 75) and the
# run counts as failed, so the suite rerun applies (Proxy, 2026-11-19: 10 min). Step 10's slowest
# healthy files kept the log quiet for about 310 s; a futex-hung file froze part 1 for 70 min.
SUITE_STALL_S=600
TO_M5=23m           # M5 <= 0.3 h
TO_INSTALL=30m
# Addendum A1 (cold /v1/models, M10/M11): one cold-catalog run after every successful probe run.
# Upper 16 min; 19 min + 45 s kill grace + 15 s sweep = 20 min = 1.25 x. Never rerun, never fatal
# by itself (a network-block failure, an OOM kill or a leftover server still stop the session).
TO_M10=19m
M10_KILL_AFTER=45s
M10_FIXTURE="$(cd "$DRIVER_DIR/../.." && pwd)/tests/unit/fixtures/perf-io/vm-catalog-providers.txt"
M10_FIXTURE_SHA256=13db8afdaf9218d42f77bf4c06544f4378fc5e19d5abf37ca00bc1242604fece
M10_ROOT="$HOME/perf-m10"   # each session's folders go under "$M10_ROOT/<M10_SESSION>"
# Addendum A2 (disk writes, M12/M13): one write step (settings D then L) after every A1 run.
# Upper 26.03 min since step-11 fix 3 (checkpoints, 6-16 s settles, paced window, row checks;
# was 22); 30 min + 45 s kill grace + two 15 s sweeps = 31.25 min < 1.25 x. Never rerun,
# never fatal by itself (network-block failure, OOM kill or a leftover server still stop it).
TO_WRITES=30m
WRITES_KILL_AFTER=45s
WRITES_ROOT="$HOME/perf-writes"   # "$WRITES_ROOT/<M10_SESSION>/<label>-<D|L>-a<attempt>"

# Measurement environment (plan): set here, so a re-login can never lose it.
export OMNIROUTE_DISABLE_BACKGROUND_SERVICES=true OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK=true \
  OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK=true NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false

usage() {
  cat >&2 <<'EOF'
usage: vm-session.sh step10 --s0 <sha>
       vm-session.sh step11 --parent <sha> --fix <sha> [--m1] [--m6] [--focused "<test files>"] [--step10-host <host.txt>] [--gate-timeout <dur>|<lint>,<typecheck>,<focused>]
       vm-session.sh step12 --s0 <sha> --s1 <sha> [--step10-host <host.txt>]
       vm-session.sh m9b --out <dir> --root-a <dir> [--root-b <dir>]
EOF
  exit 2
}

STEP="${1:-}"; [[ -n "$STEP" ]] || usage; shift
S0="" S1="" PARENT="" FIX="" JUDGE_M1=0 JUDGE_M6=0 FOCUSED="" STEP10_HOST="" M9B_OUT="" ROOT_A="" ROOT_B=""
GATE_TIMEOUT=60m   # plan: 2 x the step-10 time of each gate; step 10 itself uses this default
# One duration for every gate, or three comma-separated ones in gate order (lint, type check,
# focused tests) so each gate gets its own cap.
GATE_TIMEOUTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --s0) S0="$2"; shift 2 ;;
    --s1) S1="$2"; shift 2 ;;
    --parent) PARENT="$2"; shift 2 ;;
    --fix) FIX="$2"; shift 2 ;;
    --m1) JUDGE_M1=1; shift ;;
    --m6) JUDGE_M6=1; shift ;;
    --focused) FOCUSED="$2"; shift 2 ;;
    --step10-host) STEP10_HOST="$2"; shift 2 ;;
    --gate-timeout)
      if [[ "$2" == *,* ]]; then
        IFS=, read -r -a GATE_TIMEOUTS <<< "$2"
        [[ ${#GATE_TIMEOUTS[@]} -eq 3 ]] || { echo "--gate-timeout needs 1 or 3 durations" >&2; usage; }
      else
        GATE_TIMEOUT="$2"; GATE_TIMEOUTS=("$2")
      fi
      for _d in "${GATE_TIMEOUTS[@]}"; do   # a typo must not turn into a failed gate, and 0
        # must not slip through: GNU timeout treats a zero duration as no limit at all
        [[ "$_d" =~ ^0*[1-9][0-9]*[smhd]?$ ]] || { echo "--gate-timeout: bad duration '$_d'" >&2; usage; }
      done
      [[ "$2" == *,* ]] || GATE_TIMEOUTS=()
      shift 2 ;;
    --out) M9B_OUT="$2"; shift 2 ;;
    --root-a) ROOT_A="$2"; shift 2 ;;
    --root-b) ROOT_B="$2"; shift 2 ;;
    *) usage ;;
  esac
done

# Gate caps: cap = max(GATE_MIN_S, the given cap) (Proxy, 2026-11-19). The runbook passes 2 x
# each gate's step-10 time, and step 10's focused gate took under 1 s, so its cap would round
# to 0 s and fail every fix. gates-*.txt records the cap actually used.
GATE_MIN_S=60
dur_s() {  # dur_s <n>[smhd] -> seconds (input already validated above)
  local n="${1%[smhd]}" u="${1##*[0-9]}"
  n=$((10#$n))
  case "$u" in m) n=$((n * 60)) ;; h) n=$((n * 3600)) ;; d) n=$((n * 86400)) ;; esac
  echo "$n"
}
gate_floor() {
  if [[ "$(dur_s "$1")" -lt "$GATE_MIN_S" ]]; then echo "${GATE_MIN_S}s"; else echo "$1"; fi
}
GATE_TIMEOUT="$(gate_floor "$GATE_TIMEOUT")"
for _i in "${!GATE_TIMEOUTS[@]}"; do GATE_TIMEOUTS[_i]="$(gate_floor "${GATE_TIMEOUTS[_i]}")"; done

# ── account checks and copy-off staging (all modes) ────────────────────────────────────────
RUNNER="${PERF_RUNNER:-runner}"
COPYOFF_ROOT="/home/user/perf-out"   # readable by `user`, which `boat scp` runs as

account_problem() {  # prints why this account must not run the session; empty when fine
  local me agent
  me="$(id -un)"
  if [[ "$me" == "user" ]]; then echo "never run as 'user' (boat's agent and tunnel)"; return; fi
  if [[ "$me" != "$RUNNER" ]]; then echo "run as the measuring account '$RUNNER', not '$me'"; return; fi
  if [[ "$(systemctl show -p LoadState --value ascii-agent.service 2>/dev/null)" != "loaded" ]]; then
    echo "ascii-agent.service not found: cannot confirm boat's agent account"; return
  fi
  agent="$(systemctl show -p User --value ascii-agent.service 2>/dev/null)"
  [[ "${agent:-root}" != "$me" ]] || echo "'$me' is the account of ascii-agent.service"
}

stage_copyoff() {  # stage_copyoff <dir>: copy results where `boat scp` (as user) can read them
  local src="$1" dest
  dest="$COPYOFF_ROOT/$(basename "$src")"
  if sudo -n mkdir -p "$COPYOFF_ROOT" && sudo -n rm -rf "$dest" && sudo -n cp -a "$src" "$dest" \
     && sudo -n chown -R user:user "$COPYOFF_ROOT"; then
    echo "copy-off staged: $dest ($(find "$src" -type f | wc -l) files)" >&2
  else
    echo "COPY-OFF STAGING FAILED for $src: copy it by hand before any stop" >&2
  fi
}

problem="$(account_problem)"
if [[ -n "$problem" ]]; then echo "vm-session: $problem" >&2; exit 1; fi

# ── M9b: interactive, short, outside the detached session ──────────────────────────────────
if [[ "$STEP" == "m9b" ]]; then
  [[ -n "$M9B_OUT" && -n "$ROOT_A" ]] || usage
  # M9b only after its session finished: never against unbuilt arms, never during offline runs.
  first="$(head -1 "$M9B_OUT/summary.txt" 2>/dev/null || true)"
  if [[ "$first" != "step=step10 result=done" && "$first" != "step=step12 result=done" ]]; then
    echo "m9b: $M9B_OUT/summary.txt does not say step10/step12 result=done (got: ${first:-nothing})" >&2
    exit 1
  fi
  if pgrep -u "$(id -u)" -f 'vm-session\.sh step1[012]' > /dev/null; then
    echo "m9b: a measurement session is still running" >&2; exit 1
  fi
  if pgrep -u "$(id -u)" -f 'bin/omniroute\.mjs|server-ws\.mjs|dist/server\.js' > /dev/null; then
    echo "m9b: a server from an earlier run is still running" >&2; exit 1
  fi
  OPENROUTER_API_KEY=""
  read -rsp 'OpenRouter key: ' OPENROUTER_API_KEY || true; echo
  [[ -n "$OPENROUTER_API_KEY" ]] || { echo "m9b: no key entered" >&2; exit 1; }
  export OPENROUTER_API_KEY
  args=(--mode real --root-a "$ROOT_A" --out "$M9B_OUT/m9b.json")
  [[ -n "$ROOT_B" ]] && args+=(--root-b "$ROOT_B")
  rc=0
  (cd "$ROOT_A" && timeout 15m node --import tsx/esm scripts/perf/request-io-probe.ts "${args[@]}") \
    > "$M9B_OUT/m9b.log" 2>&1 || rc=$?
  unset OPENROUTER_API_KEY
  # The seeded DATA_DIRs hold the key; the probe deletes them, and this makes sure.
  rm -rf /tmp/omniroute-reqio-real-*
  echo "m9b exit $rc; report $M9B_OUT/m9b.json"
  stage_copyoff "$M9B_OUT"
  exit "$rc"
fi

case "$STEP" in
  step10) [[ -n "$S0" ]] || usage ;;
  step11) [[ -n "$PARENT" && -n "$FIX" ]] || usage ;;
  step12) [[ -n "$S0" && -n "$S1" ]] || usage ;;
  *) usage ;;
esac

OUT="${PERF_OUT:-$HOME/perf/$(date +%Y%m%d-%H%M)-$STEP}"
mkdir -p "$OUT"
LOG="$OUT/session.log"
RUNS="$OUT/runs.tsv"          # label  kind  arm  started  ended  load1  status  attempt
[[ -f "$RUNS" ]] || printf 'label\tkind\tarm\tstarted\tended\tload1\tstatus\tattempt\n' > "$RUNS"
# Budgets survive a resume: the wait total is a file, attempts and reruns are counted from the
# "started" rows in runs.tsv (written before each attempt, so an interrupted attempt counts).
# A1: a random id per session, written once to $OUT and read back on resume. The cold-catalog
# folders and owner tokens use it, so two sessions never share a folder or a token, even when
# their OUT paths have the same basename.
M10_SESSION_FILE="$OUT/m10-session-id"
if [[ ! -s "$M10_SESSION_FILE" ]]; then
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$M10_SESSION_FILE"
fi
M10_SESSION="$(cat "$M10_SESSION_FILE")"
[[ "$M10_SESSION" =~ ^[0-9a-f]{32}$ ]] || { echo "bad $M10_SESSION_FILE" >&2; exit 1; }
WAIT_FILE="$OUT/wait_total_s"
WAIT_TOTAL="$(cat "$WAIT_FILE" 2>/dev/null || echo 0)"
date -u +%FT%TZ >> "$OUT/starts.txt"
START_N="$(wc -l < "$OUT/starts.txt")"
attempts_of() { awk -F'\t' -v l="$1" '$1 == l && $7 == "started" { n++ } END { print n + 0 }' "$RUNS"; }
reruns_used() {  # reruns_used <build|suite|bench>; m10 and writes rows never count (A1, A2)
  awk -F'\t' -v c="$1" 'function cls(k) { return k == "build" ? "build" : k == "suite" ? "suite" : "bench" }
    $7 == "started" && $8 == 2 && $2 != "m10" && $2 != "writes" && cls($2) == c { n++ } END { print n + 0 }' "$RUNS"
}
ended_any() { awk -F'\t' -v l="$1" '$1 == l && $7 != "started" { f = 1 } END { exit !f }' "$RUNS"; }

say() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG" >&2; }
die() { say "SESSION STOPPED: $*"; summary "stopped: $*"; exit 1; }
summary() {
  {
    echo "step=$STEP result=$1"
    echo "starts=$START_N wait_total_s=$WAIT_TOTAL build_reruns=$(reruns_used build)" \
      "suite_reruns=$(reruns_used suite) bench_reruns=$(reruns_used bench)"
    date -u +%FT%TZ
  } > "$OUT/summary.txt"
  stage_copyoff "$OUT"
}
done_ok() { awk -F'\t' -v l="$1" '$1 == l && $7 == "ok" { f = 1 } END { exit !f }' "$RUNS"; }
report_ok() {  # report_ok <kind> <file>: fixed checks per kind, no code from arguments
  node -e '
    const [kind, file] = process.argv.slice(1);
    const r = JSON.parse(require("fs").readFileSync(file, "utf8"));
    let ok = false;
    if (kind === "build") ok = r.status === "ok";
    if (kind === "base") {
      const m = r.measurements || {};
      ok = Object.entries(m).every(([k, v]) =>
        k === "buildSeconds" ? true : k === "ttft" ? Object.values(v).every((t) => t.status === "ok") : v.status === "ok");
    }
    if (kind === "probe") ok = r.status === "ok";   // idleCheck is reported and flagged, not a gate (plan)
    process.exit(ok ? 0 : 1);' "$1" "$2"
}

# ── preflight ──────────────────────────────────────────────────────────────────────────────
preflight() {
  { lscpu; nproc; free -m; uname -a; node --version; pnpm --version; npm --version; } > "$OUT/host.txt" 2>&1 \
    || die "tooling missing (node, pnpm, npm)"
  # The account itself was checked at start (account_problem); record what was seen.
  echo "measuring account=$(id -un); ascii-agent User=$(systemctl show -p User --value ascii-agent.service 2>/dev/null)" \
    >> "$OUT/host.txt"
  # OOM kills are read from the kernel journal per run; fail closed when it cannot be read.
  sudo -n journalctl -k -n 1 --no-pager > /dev/null 2>&1 || die "cannot read the kernel journal (sudo journalctl -k)"
  command -v iptables >/dev/null && command -v systemd-run >/dev/null || die "iptables or systemd-run missing"
  if [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)" != "1" ]]; then
    command -v ip6tables >/dev/null || die "IPv6 is on but ip6tables is missing"
  fi
  # A1: both arms read the same provider list, from the driver's checkout (the arms predate it).
  [[ -f "$M10_FIXTURE" ]] || die "A1 fixture missing: $M10_FIXTURE"
  [[ "$(sha256sum "$M10_FIXTURE" | cut -d' ' -f1)" == "$M10_FIXTURE_SHA256" ]] \
    || die "A1 fixture hash differs from M10_FIXTURE_SHA256: $M10_FIXTURE"
  echo "m10 fixture=$M10_FIXTURE sha256=$M10_FIXTURE_SHA256" >> "$OUT/host.txt"
  # The suite parts run under stall-guard.sh (bash 5.1+); a one-second self-test here fails the
  # session at the start instead of in part 1.
  bash "$DRIVER_DIR/stall-guard.sh" 5 /dev/null -- true 2>> "$LOG" \
    || die "stall-guard.sh self-test failed (needs bash 5.1+; see $LOG)"
  echo "suite stall limit=${SUITE_STALL_S}s; gate caps=${GATE_TIMEOUTS[*]:-$GATE_TIMEOUT} (min ${GATE_MIN_S}s)" >> "$OUT/host.txt"
}

no_leftovers() {
  if pgrep -u "$(id -u)" -f 'bin/omniroute\.mjs|server-ws\.mjs|dist/server\.js' > /dev/null; then
    pgrep -u "$(id -u)" -af 'bin/omniroute\.mjs|server-ws\.mjs|dist/server\.js' >> "$LOG"
    die "a server from an earlier run is still running (see $LOG)"
  fi
}

cpu_model() { lscpu | awk -F: '/Model name/ { gsub(/^ +/, "", $2); print $2; exit }'; }

# ── repo and arms ──────────────────────────────────────────────────────────────────────────
prepare_repo() {
  if [[ ! -d "$REPO/.git" ]]; then
    git clone -b "$BASE_BRANCH" "$BASE_URL" "$REPO" >> "$LOG" 2>&1 || die "clone failed"
  fi
  # Always fetch the newest bundle (a resumed sandbox gets new commits this way).
  git -C "$REPO" fetch "$BUNDLE" "+fix-unit-tests-ccr:refs/heads/fix-unit-tests-ccr" >> "$LOG" 2>&1 \
    || die "bundle fetch failed"
}

arm() {  # arm <dir> <sha>: (re)create the worktree unless it already holds <sha> with an install
  local dir="$1" sha full
  full="$(git -C "$REPO" rev-parse --verify "$2^{commit}")" || die "unknown commit $2"
  if [[ -f "$dir/.perf-arm-sha" && "$(cat "$dir/.perf-arm-sha")" == "$full" && -d "$dir/node_modules" ]]; then
    say "arm $dir already at $full"; ARM_FRESH=0; return
  fi
  git -C "$REPO" worktree remove --force "$dir" > /dev/null 2>&1 || rm -rf "$dir"
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add --detach "$dir" "$full" >> "$LOG" 2>&1 || die "worktree add $dir failed"
  (cd "$dir" && timeout "$TO_INSTALL" pnpm install --frozen-lockfile) >> "$LOG" 2>&1 || die "install in $dir failed"
  echo "$full" > "$dir/.perf-arm-sha"
  echo "$START_N" > "$dir/.perf-install-id"   # a fresh install needs its own discarded first build
  echo "$full" > "$OUT/$(basename "$dir").sha"
  ARM_FRESH=1
}

# The perf tools are newer than S0/PARENT. Both arms get the driver's copies (identical tooling;
# untracked files in the arm), so the probe resolves its seed and preload inside the arm, and the
# seed migrates DATA_DIR with the arm's own src/. lts-baseline is in every arm and stays the arm's.
tools() {  # tools <dir>
  local f
  for f in request-io-probe.ts request-io-seed.ts request-io-preload.mjs time-build.mjs \
           catalog-cold-probe.ts write-bytes-probe.ts; do
    cp "$DRIVER_DIR/$f" "$1/scripts/perf/$f" || die "could not copy $f into $1"
  done
}

# ── one measured run, with load gate, timeout, status check and rerun cap ─────────────────
idle_gate() {
  local t0 rc=0 left cap
  # Per-run cap 600 s, but never past the session total: the cap is what is left of 1800 s,
  # rounded down to wait-idle's 30 s poll, so the counted wait cannot pass the total.
  left=$(( MAX_WAIT_TOTAL_S - WAIT_TOTAL ))
  cap=$(( left < 600 ? left : 600 )); cap=$(( cap - cap % 30 ))
  t0=$(date +%s)
  PERF_WAIT_MAX_S="$cap" bash "$DRIVER_DIR/wait-idle.sh" 2>> "$LOG" || rc=$?
  WAIT_TOTAL=$(( WAIT_TOTAL + $(date +%s) - t0 ))
  echo "$WAIT_TOTAL" > "$WAIT_FILE"
  [[ "$rc" -eq 0 ]] || die "load gate: no idle host within the per-run cap"
  [[ "$WAIT_TOTAL" -le "$MAX_WAIT_TOTAL_S" ]] || die "load gate: ${WAIT_TOTAL}s waited this session (cap ${MAX_WAIT_TOTAL_S}s)"
}

check_report() {  # check_report <kind> <file> <rc> -> 0 when the run counts as ok
  local kind="$1" f="$2" rc="$3"
  case "$kind" in
    build|base|probe) [[ "$rc" -eq 0 && -s "$f" ]] && report_ok "$kind" "$f" ;;
    m5) [[ "$rc" -eq 0 ]] ;;     # no JSON report: the helper's own exit code decides
    suite) [[ "$rc" -eq 0 ]] ;;  # 0 = every part ended with rc 0 or 1 (failing tests are timed, not fatal)
    *) return 1 ;;
  esac
}

rerun_allowed() {  # rerun_allowed <kind>: session cap, counted from runs.tsv
  case "$1" in
    build) [[ "$(reruns_used build)" -lt "$MAX_BUILD_RERUNS" ]] ;;
    suite) [[ "$(reruns_used suite)" -lt "$MAX_SUITE_RERUNS" ]] ;;
    *)     [[ "$(reruns_used bench)" -lt "$MAX_BENCH_RERUNS" ]] ;;
  esac
}

# keep_attempt <label> <n>: move $OUT/<label>.* and $OUT/<label>-* into $OUT/attempts/<label>-a<n>/.
# With no matching files it does nothing; stray files before a first attempt go to -a0. A
# folder that already exists (a resumed session) gets a numbered sibling, so nothing is
# ever overwritten.
keep_attempt() {
  local label="$1" n="$2" keep f i=1
  local files=()
  shopt -s nullglob
  files=("${OUT:?}/$label".* "${OUT:?}/$label"-*)
  shopt -u nullglob
  [[ "${#files[@]}" -gt 0 ]] || return 0
  keep="$OUT/attempts/$label-a$n"
  while [[ -e "$keep" ]]; do keep="$OUT/attempts/$label-a$n.$i"; i=$((i + 1)); done
  mkdir -p "$keep" || die "could not create $keep"
  for f in "${files[@]}"; do mv -- "$f" "$keep/" || die "could not move $f to $keep"; done
}

# measure <label> <kind> <arm-dir> <timeout> <report-file> -- <command...>
measure() {
  local label="$1" kind="$2" dir="$3" to="$4" report="$5"; shift 6
  if done_ok "$label"; then say "skip $label (done)"; return 0; fi
  local attempt rc started load
  attempt=$(( $(attempts_of "$label") + 1 ))
  while :; do
    [[ "$attempt" -le 2 ]] || die "$label: both attempts used (failed twice, or interrupted and failed)"
    if [[ "$attempt" -eq 2 ]] && ! rerun_allowed "$kind"; then die "$label failed: no rerun left this session"; fi
    no_leftovers
    idle_gate
    # A failed attempt must never leave an earlier report behind to be read as this run's, but
    # its files are evidence: move them to attempts/<label>-a<n>/ (copied off with $OUT).
    keep_attempt "$label" "$((attempt - 1))"
    load="$(cut -d' ' -f1 /proc/loadavg)"
    started="$(date -u +%FT%TZ)"
    printf '%s\t%s\t%s\t%s\t-\t%s\tstarted\t%s\n' "$label" "$kind" "$(basename "$dir")" "$started" \
      "$load" "$attempt" >> "$RUNS"
    say "run $label ($kind, $(basename "$dir"), attempt $attempt, load $load)"
    rc=0
    local since; since="@$(date +%s)"
    (cd "$dir" && timeout --kill-after=30s "$to" "$@") > "$OUT/$label.out" 2> "$OUT/$label.log" || rc=$?
    local status="ok"
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then status="timeout"
    elif [[ "$rc" -eq 90 || "$rc" -eq 91 ]]; then status="netblock-$rc"
    elif ! check_report "$kind" "$report" "$rc"; then status="failed(rc=$rc)"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$kind" "$(basename "$dir")" "$started" \
      "$(date -u +%FT%TZ)" "$load" "$status" "$attempt" >> "$RUNS"
    if sudo -n journalctl -k --since "$since" --no-pager 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
      die "OOM kill during $label"
    fi
    [[ "$status" == "ok" ]] && return 0
    [[ "$status" == netblock-* ]] && die "network block failed ($status) in $label"
    [[ "$status" == "timeout" ]] && die "$label ran past its timeout ($to)"
    say "$label: $status"
    attempt=$((attempt + 1))
  done
}

# ── A1: one cold-catalog run (M10/M11) ─────────────────────────────────────────────────────
# m10_sweep <label> <data-dir> <token>: after a non-ok ending, stop whatever still uses the run's
# folder and delete it, but only when the folder's owner marker carries this attempt's token, so
# nothing this attempt did not create is touched. m10-sweep.mjs is plain node (the driver checkout
# has no node_modules) and deletes the folder only once no process uses it. A server that
# survives is caught by the next no_leftovers, which stops the session.
m10_sweep() {
  local label="$1" d="$2" token="$3" rc=0
  timeout 15s node "$DRIVER_DIR/m10-sweep.mjs" "$d" "$token" >> "$LOG" 2>&1 || rc=$?
  case "$rc" in
    0) ;;
    2) say "$label: $d has no owner marker for this attempt; left alone" ;;
    3) say "$label: a process still uses $d after the sweep; folder left, no_leftovers decides" ;;
    *) say "$label: sweep of $d failed (rc=$rc, see $LOG); folder left" ;;
  esac
}

# m10 <probe-label> <arm-dir>: label <probe-label>-m10 in runs.tsv (kind m10). Skipped once it has
# an ended row; a label interrupted twice is recorded invalid(interrupted). No load gate (it
# follows a probe run that passed one; the probe itself marks load >= 2.0 invalid(load)).
m10() {
  local label="$1-m10" dir="$2" n attempt rc=0 status started load since token d reason
  if ended_any "$label"; then say "skip $label (recorded)"; return 0; fi
  n="$(attempts_of "$label")"
  if [[ "$n" -ge 2 ]]; then
    printf '%s\tm10\t%s\t-\t%s\t-\tinvalid(interrupted)\t%s\n' "$label" "$(basename "$dir")" \
      "$(date -u +%FT%TZ)" "$n" >> "$RUNS"
    say "$label: interrupted twice, recorded invalid"
    return 0
  fi
  attempt=$((n + 1))
  # Folder and token are fixed per session id, label and attempt, so a resumed driver can still
  # prove it created an interrupted attempt's folder and sweep it before the next attempt.
  m10_dir() { echo "$M10_ROOT/$M10_SESSION/$label-a$1"; }
  m10_token() { echo "$M10_SESSION:$label:a$1"; }
  [[ "$attempt" -eq 2 ]] && m10_sweep "$label" "$(m10_dir 1)" "$(m10_token 1)"
  no_leftovers
  keep_attempt "$label" "$((attempt - 1))"   # an interrupted attempt's files are kept
  d="$(m10_dir "$attempt")"
  token="$(m10_token "$attempt")"
  load="$(cut -d' ' -f1 /proc/loadavg)"
  started="$(date -u +%FT%TZ)"
  printf '%s\tm10\t%s\t%s\t-\t%s\tstarted\t%s\n' "$label" "$(basename "$dir")" "$started" \
    "$load" "$attempt" >> "$RUNS"
  say "run $label (m10, $(basename "$dir"), attempt $attempt, load $load)"
  since="@$(date +%s)"
  (cd "$dir" && timeout --kill-after="$M10_KILL_AFTER" "$TO_M10" "${NB[@]}" \
     node --import tsx/esm scripts/perf/catalog-cold-probe.ts --root . --label "$label" \
     --providers "$M10_FIXTURE" --out "$OUT/$label.json" --log "$OUT/$label.log" \
     --data-dir "$d" --owner-token "$token") > "$OUT/$label.out" 2>> "$OUT/$label.log" || rc=$?
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then status="timeout"
  elif [[ "$rc" -eq 90 || "$rc" -eq 91 ]]; then status="netblock-$rc"
  elif [[ "$rc" -ne 0 ]]; then status="invalid(rc=$rc)"
  else
    reason="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(r.valid === true ? "ok" : String(r.invalidReason || "unknown").replace(/[\t\n]/g, " "));' \
      "$OUT/$label.json" 2>/dev/null || echo "no-report")"
    if [[ "$reason" == "ok" ]]; then status="ok"; else status="invalid($reason)"; fi
  fi
  printf '%s\tm10\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$(basename "$dir")" "$started" \
    "$(date -u +%FT%TZ)" "$load" "$status" "$attempt" >> "$RUNS"
  [[ "$status" == "ok" ]] || m10_sweep "$label" "$d" "$token"
  if sudo -n journalctl -k --since "$since" --no-pager 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
    die "OOM kill during $label"
  fi
  [[ "$status" == netblock-* ]] && die "network block failed ($status) in $label"
  say "$label: $status"
  return 0
}

# ── A2: one write run, settings D then L (M12/M13) ────────────────────────────────────────
# writes <probe-label> <arm-dir> [suffix]: label <probe-label>-writes<suffix> in runs.tsv (kind
# writes). Same rules as m10: skipped once ended, invalid(interrupted) after two starts, no load
# gate (the probe marks load >= 2.0 invalid), both folders swept with m10-sweep.mjs. Never
# rerun, except writes_retry's one retry. Status is ok only when both settings are valid;
# otherwise invalid(D:<reason>,L:<reason>).
writes() {
  local label="$1-writes${3:-}" dir="$2" n attempt rc=0 status started load since token reason s
  if ended_any "$label"; then say "skip $label (recorded)"; return 0; fi
  n="$(attempts_of "$label")"
  if [[ "$n" -ge 2 ]]; then
    printf '%s\twrites\t%s\t-\t%s\t-\tinvalid(interrupted)\t%s\n' "$label" "$(basename "$dir")" \
      "$(date -u +%FT%TZ)" "$n" >> "$RUNS"
    say "$label: interrupted twice, recorded invalid"
    return 0
  fi
  attempt=$((n + 1))
  # Folders and token fixed per session id, label and attempt (see m10).
  writes_dir() { echo "$WRITES_ROOT/$M10_SESSION/$label-$2-a$1"; }
  writes_token() { echo "$M10_SESSION:$label:a$1"; }
  if [[ "$attempt" -eq 2 ]]; then
    for s in D L; do m10_sweep "$label" "$(writes_dir 1 "$s")" "$(writes_token 1)"; done
  fi
  no_leftovers
  keep_attempt "$label" "$((attempt - 1))"   # an interrupted attempt's files are kept
  token="$(writes_token "$attempt")"
  load="$(cut -d' ' -f1 /proc/loadavg)"
  started="$(date -u +%FT%TZ)"
  printf '%s\twrites\t%s\t%s\t-\t%s\tstarted\t%s\n' "$label" "$(basename "$dir")" "$started" \
    "$load" "$attempt" >> "$RUNS"
  say "run $label (writes, $(basename "$dir"), attempt $attempt, load $load)"
  since="@$(date +%s)"
  (cd "$dir" && timeout --kill-after="$WRITES_KILL_AFTER" "$TO_WRITES" "${NB[@]}" \
     node --import tsx/esm scripts/perf/write-bytes-probe.ts --root . --label "$label" \
     --out "$OUT/$label.json" --log "$OUT/$label.log" \
     --data-dir-d "$(writes_dir "$attempt" D)" --data-dir-l "$(writes_dir "$attempt" L)" \
     --owner-token "$token") > "$OUT/$label.out" 2>> "$OUT/$label.log" || rc=$?
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then status="timeout"
  elif [[ "$rc" -eq 90 || "$rc" -eq 91 ]]; then status="netblock-$rc"
  elif [[ "$rc" -ne 0 ]]; then status="invalid(rc=$rc)"
  else
    reason="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const s = Array.isArray(r.settings) ? r.settings : [];
      const ok = s.length === 2 && s.every((x) => x.valid === true);
      const why = s.map((x) => x.setting + ":" + (x.valid ? "ok" : String(x.invalidReason || "unknown")));
      console.log(ok ? "ok" : (why.join(",") || String(r.invalidReason || "unknown")).replace(/[\t\n]/g, " "));' \
      "$OUT/$label.json" 2>/dev/null || echo "no-report")"
    if [[ "$reason" == "ok" ]]; then status="ok"; else status="invalid($reason)"; fi
  fi
  printf '%s\twrites\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$(basename "$dir")" "$started" \
    "$(date -u +%FT%TZ)" "$load" "$status" "$attempt" >> "$RUNS"
  # Every ending: the probe keeps a folder a process still uses even when the run is ok, and
  # an absent folder is a quiet no-op (m10-sweep exit 0).
  for s in D L; do m10_sweep "$label" "$(writes_dir "$attempt" "$s")" "$token"; done
  if sudo -n journalctl -k --since "$since" --no-pager 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
    die "OOM kill during $label"
  fi
  [[ "$status" == netblock-* ]] && die "network block failed ($status) in $label"
  say "$label: $status"
  return 0
}

# Fix-3 rerun addendum (Proxy, 2026-11-21): a pair run (probe-p<k>-<a|b>) whose write run's only
# fault is the paced window gets one retry, label <probe-label>-writes-retry; the comparison then
# takes every write metric of that run from the retry. At most 6 (one per pair run). Noise and
# step-10 runs, and any other fault, are never retried. Works on resume: it reads runs.tsv.
WRITES_RETRY_STATUS="invalid(D:paced-status,L:ok)"
writes_retry() {  # writes_retry <probe-label> <arm-dir>
  [[ "$1" =~ ^probe-p[0-9]+-[ab]$ ]] || return 0
  local first
  first="$(awk -F'\t' -v l="$1-writes" '$1 == l && $7 != "started" { s = $7 } END { print s }' "$RUNS")"
  [[ "$first" == "$WRITES_RETRY_STATUS" ]] || return 0
  say "$1-writes: $first, one retry"
  writes "$1" "$2" -retry
}

NB=(bash "$DRIVER_DIR/netblock-run.sh" --)

build()  { measure "$1" build "$2" "$TO_BUILD" "$OUT/$1.json" -- node scripts/perf/time-build.mjs --root . --out "$OUT/$1.json"; }
discard() { build "build-discard-$1-i$(cat "$2/.perf-install-id")" "$2"; }   # discard <a|b> <dir>
base()   { measure "$1" base "$2" "$TO_BASE" "$OUT/$1.json" -- \
             "${NB[@]}" node scripts/perf/lts-baseline.mjs --runs 50 --out "$OUT/$1.json" --md; }
probe()  { local idle=(); [[ "${3:-0}" -gt 0 ]] && idle=(--idle-check-seconds "$3")
           measure "$1" probe "$2" "$TO_PROBE" "$OUT/$1.json" -- \
             "${NB[@]}" node --import tsx/esm scripts/perf/request-io-probe.ts --root . \
             --out "$OUT/$1.json" --counters-out "$OUT/$1.counters" "${idle[@]}"
           m10 "$1" "$2"   # measure returned: this label's counted attempt is ok
           writes "$1" "$2"   # A2, after A1's step
           writes_retry "$1" "$2"
           if [[ "${3:-0}" -gt 0 ]]; then   # idle check: reported and flagged, never a gate (plan)
             node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
               const z = r.metrics?.idleCheck?.allZero;
               console.log(process.argv[2] + " idleCheck.allZero=" + z + (z === true ? "" : "  <- FLAG"));' \
               "$OUT/$1.json" "$1" >> "$OUT/flags.txt" 2>&1 || echo "$1 idleCheck unreadable  <- FLAG" >> "$OUT/flags.txt"
           fi; }
m5()     { measure "$1" m5 "$2" "$TO_M5" "" -- bash -c '
             set -euo pipefail; out="$1"; cache="$2"
             du -sb dist > "$out-dist.txt"
             rm -rf "$out-pack"; mkdir -p "$out-pack"
             pnpm pack --pack-destination "$out-pack" > /dev/null; ls -l "$out-pack" > "$out-pack.txt"
             h="$(mktemp -d)"; pfx="$(mktemp -d)"; trap "rm -rf \"$h\" \"$pfx\"" EXIT
             HOME="$h" npm_config_cache="$cache" npm install --omit=dev --ignore-scripts --prefix "$pfx" "$out-pack"/*.tgz > /dev/null
             du -sb "$pfx" > "$out-install.txt"
             (cd "$pfx" && npm ls --all --json > "$out-tree.json") || true' m5 "$OUT/$1" "$NPM_CACHE"; }
suite()  { measure "$1" suite "$2" "$((TO_SUITE_S + 60))s" "" -- bash -c '
             out="$1"; deadline=$(( $(date +%s) + $2 )); g="$3"; stall="$4"
             export DISABLE_SQLITE_AUTO_BACKUP=true C=8
             for p in 1 2 3; do
               to=$(( deadline - $(date +%s) )); [ "$to" -gt 0 ] || exit 124
               to="${to}s"; s=$(date +%s.%N); rc=0
               case $p in
                 1) bash "$g" "$stall" "$out.part$p.log" -- timeout --kill-after=30s "$to" node --max-old-space-size=8192 --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=$C tests/unit/*.test.ts "tests/unit/{api,auth,authz,build,chatcore,cli,cli-helper,combo,compression,correctness,cors,db,db-adapters,docs,guardrails,lib,memory,runtime,security,services,settings,shared,translator,ui,usage}/**/*.test.ts" "tests/unit/**/*.test.mjs" ;;
                 2) bash "$g" "$stall" "$out.part$p.log" -- timeout --kill-after=30s "$to" node --max-old-space-size=8192 --import tsx --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=$C "tests/unit/dashboard/**/*.test.ts" ;;
                 3) bash "$g" "$stall" "$out.part$p.log" -- timeout --kill-after=30s "$to" pnpm run test:unit:serial ;;
               esac > "$out.part$p.log" 2>&1 || rc=$?
               awk -v a="$s" -v b="$(date +%s.%N)" -v p="$p" -v rc="$rc" "BEGIN { printf \"part%s %.1f rc=%s\\n\", p, b - a, rc }" >> "$out.txt"
               [ "$rc" -eq 124 ] && exit 124
               # 137 after the deadline = the inner timeout had to SIGKILL (--kill-after): still the
               # deadline. Before it, 137 is a SIGKILL from outside (failed, below).
               [ "$rc" -eq 137 ] && [ "$(date +%s)" -ge "$deadline" ] && exit 124
               # 75 = stall-guard killed a part whose log stopped growing: failed, rerun allowed.
               [ "$rc" -eq 75 ] && exit 75
               # 0 = pass, 1 = failing tests (still a valid timing). Anything else (signal, OOM, no
               # start) is not a suite run and must not count as a fast sample.
               [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || exit 70
             done; exit 0' suite "$OUT/$1" "$TO_SUITE_S" "$DRIVER_DIR/stall-guard.sh" "$SUITE_STALL_S"; }
gates()  {  # gates <label> <dir>: timed; a failing gate is recorded, a gate past its cap stops
  local label="$1" dir="$2" i=0 c s rc to
  rm -f "$OUT/$label.txt"
  for c in "pnpm run lint" "pnpm run typecheck:core" ${FOCUSED:+"node --import tsx/esm --test $FOCUSED"}; do
    i=$((i + 1)); s=$(date +%s); rc=0; to="${GATE_TIMEOUTS[$((i - 1))]:-$GATE_TIMEOUT}"
    # $c is one of the fixed commands above; word splitting into argv is intended.
    # shellcheck disable=SC2086
    (cd "$dir" && timeout --kill-after=30s "$to" $c) > "$OUT/$label-$i.log" 2>&1 || rc=$?
    echo "$c :: $(( $(date +%s) - s ))s rc=$rc cap=$to" >> "$OUT/$label.txt"
    [[ "$rc" -eq 124 || "$rc" -eq 137 ]] && die "gate '$c' ran past its cap ($to)"
  done
  return 0
}

warmup() {  # discarded runs after every (re)start of a session: one label set per start
  base "warm-s$START_N-base" "$1"; probe "warm-s$START_N-probe" "$1"
}

cpu_check() {  # re-estimate noise with 3 extra parent-arm runs when the CPU model changed
  [[ -n "$STEP10_HOST" ]] || return 0
  local was now; was="$(awk -F: '/Model name/ { gsub(/^ +/, "", $2); print $2; exit }' "$STEP10_HOST")"; now="$(cpu_model)"
  if [[ "$was" != "$now" ]]; then
    say "CPU model changed ('$was' -> '$now'): 3 extra parent-arm runs for the noise bands"
    for i in 1 2 3; do base "noise-base-$i" "$ARM_A"; probe "noise-probe-$i" "$ARM_A"; done
  fi
}

pairs() {  # 3 interleaved pairs: AB, BA, AB
  local k=0 order
  for order in "a b" "b a" "a b"; do
    k=$((k + 1))
    for x in $order; do
      local d="$ARM_A"; [[ "$x" == b ]] && d="$ARM_B"
      base "base-p$k-$x" "$d"; probe "probe-p$k-$x" "$d"
    done
  done
}

# ── sessions ───────────────────────────────────────────────────────────────────────────────
preflight
prepare_repo
say "session $STEP start; OUT=$OUT"

case "$STEP" in
  step10)
    arm "$ARM_A" "$S0"; tools "$ARM_A"
    discard a "$ARM_A"
    for i in 1 2 3; do build "build-$i" "$ARM_A"; done
    warmup "$ARM_A"
    for i in 1 2 3 4 5; do
      base "base-r$i" "$ARM_A"
      if [[ "$i" -eq 1 ]]; then probe "probe-r$i" "$ARM_A" 60; else probe "probe-r$i" "$ARM_A"; fi
    done
    m5 "m5-a" "$ARM_A"
    suite "suite-r1" "$ARM_A"; suite "suite-r2" "$ARM_A"
    FOCUSED="tests/unit/lts-baseline.test.ts" gates "gates-a" "$ARM_A"   # a focused file that exists at S0
    say "next: M9b on S0 (interactive): bash $DRIVER_DIR/vm-session.sh m9b --out $OUT --root-a $ARM_A"
    ;;
  step11)
    arm "$ARM_A" "$PARENT"; arm "$ARM_B" "$FIX"; tools "$ARM_A"; tools "$ARM_B"
    discard a "$ARM_A"; discard b "$ARM_B"
    cpu_check
    if [[ "$JUDGE_M1" -eq 1 ]]; then
      build "build-1-a" "$ARM_A"; build "build-1-b" "$ARM_B"; build "build-2-a" "$ARM_A"; build "build-2-b" "$ARM_B"
    fi
    warmup "$ARM_A"
    pairs
    m5 "m5-a" "$ARM_A"; m5 "m5-b" "$ARM_B"
    if [[ "$JUDGE_M6" -eq 1 ]]; then
      suite "suite-p1-a" "$ARM_A"; suite "suite-p1-b" "$ARM_B"; suite "suite-p2-b" "$ARM_B"; suite "suite-p2-a" "$ARM_A"
    fi
    gates "gates-b" "$ARM_B"
    ;;
  step12)
    arm "$ARM_A" "$S0"; arm "$ARM_B" "$S1"; tools "$ARM_A"; tools "$ARM_B"
    discard a "$ARM_A"; discard b "$ARM_B"
    cpu_check
    build "build-1-a" "$ARM_A"; build "build-1-b" "$ARM_B"; build "build-2-a" "$ARM_A"; build "build-2-b" "$ARM_B"
    warmup "$ARM_A"
    pairs
    m5 "m5-a" "$ARM_A"; m5 "m5-b" "$ARM_B"
    suite "suite-p1-a" "$ARM_A"; suite "suite-p1-b" "$ARM_B"; suite "suite-p2-b" "$ARM_B"; suite "suite-p2-a" "$ARM_A"
    say "next: M9b on both arms (interactive): bash $DRIVER_DIR/vm-session.sh m9b --out $OUT --root-a $ARM_A --root-b $ARM_B"
    ;;
esac

say "session $STEP done"
summary "done"   # also stages $OUT to $COPYOFF_ROOT for boat scp
