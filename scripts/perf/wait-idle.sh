#!/usr/bin/env bash
# Stage-2 T4: wait until the 1-minute load average drops below a threshold.
#
# Reads the first field of /proc/loadavg (overridable with PERF_LOADAVG_FILE
# for tests), polls every PERF_WAIT_POLL_S seconds (default 30), gives up
# after PERF_WAIT_MAX_S seconds (default 600). Exit 0 when idle, 92 on
# timeout. Prints the waited seconds to stderr. Float comparison is done with
# awk, not bash arithmetic. The awk variable is not called `load`: gawk 5
# reserves that name and exits with an error, which read as "busy" forever.
set -euo pipefail

MAX_LOAD="${PERF_MAX_LOAD:-2.0}"
WAIT_MAX_S="${PERF_WAIT_MAX_S:-600}"
POLL_S="${PERF_WAIT_POLL_S:-30}"
LOADAVG_FILE="${PERF_LOADAVG_FILE:-/proc/loadavg}"

waited=0
while true; do
  load="$(cut -d' ' -f1 < "$LOADAVG_FILE")"
  if awk -v cur="$load" -v max="$MAX_LOAD" 'BEGIN { exit !(cur < max) }'; then
    echo "wait-idle: idle after ${waited}s (load ${load} < ${MAX_LOAD})" >&2
    exit 0
  fi
  if [[ "$waited" -ge "$WAIT_MAX_S" ]]; then
    echo "wait-idle: timeout after ${waited}s (load ${load} >= ${MAX_LOAD})" >&2
    exit 92
  fi
  sleep "$POLL_S"
  waited=$((waited + POLL_S))
done
