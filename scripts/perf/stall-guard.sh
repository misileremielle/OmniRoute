#!/usr/bin/env bash
# stall-guard.sh <stall-seconds> <log-file> -- <command...>
#
# Runs <command> in its own process group and watches <log-file> (where the caller sends the
# command's output). If the file does not grow for <stall-seconds>, the whole group is killed
# with SIGKILL and stall-guard exits 75. Otherwise it exits with the command's own status, so a
# `timeout` inside keeps its 124. SIGTERM/SIGINT/SIGHUP to stall-guard go to the whole group.
#
# Why: a unit-test file blocked on a futex (2026-11-19, step 10) froze a suite part for 70 min.
# Node's --test-timeout cannot end it (the timer lives in the blocked child), and a TERM to the
# runner makes it exit 1, which the suite counts as a valid timing. 75 is a status no test
# command returns, so the suite body treats it as "not a suite run" and the driver reruns it.
# A forwarded TERM/INT/HUP ends the guard with 128 + the signal number even when the command
# itself exits 0 or 1 (the node runner exits 1 on TERM), so a stopped part never counts as a
# timing. A group still alive STALL_KILL_AFTER_S (15) after a forwarded signal is SIGKILLed,
# also when the command itself has already exited; after a normal end, leftovers get 5 s. The
# guard never exits with its group still running (it reports if SIGKILL did not clear it in
# 10 s), and prints the longest quiet gap it saw. STALL_KILL_AFTER_S + 10 s stays below the
# 30 s `--kill-after` of the driver's outer `timeout` (measure()), so the guard has emptied its
# group even if that `timeout` is still alive and SIGKILLs its own group; after a signal the
# guard polls every second.
# STALL_POLL_S (default 15) sets how often the size is checked. The command's end is noticed at
# once (`wait -n`, bash 5.1+), so the guard adds no time to a part that leaves no process behind;
# with leftovers it adds up to 5 s + 10 s and prints how long ("group empty N ms after ...").
set -u
if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1) )); then
  echo "stall-guard: needs bash 5.1 or newer (wait -n -p), found $BASH_VERSION" >&2
  exit 2
fi
STALL_S="${1:?usage: stall-guard.sh <stall-seconds> <log-file> -- <command...>}"
LOG="${2:?usage: stall-guard.sh <stall-seconds> <log-file> -- <command...>}"
[[ "${3:-}" == "--" ]] || { echo "stall-guard: expected -- before the command" >&2; exit 2; }
shift 3
[[ $# -gt 0 ]] || { echo "stall-guard: no command" >&2; exit 2; }
[[ "$STALL_S" =~ ^[1-9][0-9]*$ ]] || { echo "stall-guard: bad stall seconds '$STALL_S'" >&2; exit 2; }
POLL="${STALL_POLL_S:-15}"
[[ "$POLL" =~ ^[0-9]+(\.[0-9]+)?$ && ! "$POLL" =~ ^0+(\.0+)?$ ]] \
  || { echo "stall-guard: bad STALL_POLL_S '$POLL'" >&2; exit 2; }
if ! command -v pgrep > /dev/null || ! command -v setsid > /dev/null; then
  echo "stall-guard: pgrep or setsid missing" >&2
  exit 2
fi
KILL_AFTER="${STALL_KILL_AFTER_S:-15}"
[[ "$KILL_AFTER" =~ ^[1-9][0-9]*$ ]] || { echo "stall-guard: bad STALL_KILL_AFTER_S '$KILL_AFTER'" >&2; exit 2; }

size() { stat -c %s "$LOG" 2> /dev/null || echo -1; }
now_ms() { local t="${EPOCHREALTIME/[.,]/}"; echo $(( t / 1000 )); }   # bash 5 clock, ms

pid="" sig="" sig_name="" sig_at=0 max_quiet=0
forward() {  # forward <name> <number>: to the group, or to the process before setsid() ran
  if [[ -n "$pid" ]]; then
    kill -"$1" -- "-$pid" 2> /dev/null || kill -"$1" "$pid" 2> /dev/null
  fi
  [[ -n "$sig" ]] || { sig="$2"; sig_name="$1"; sig_at=$(now_ms); }
}
# Traps before the command starts: a signal that comes first is remembered and sent after.
trap 'forward TERM 15' TERM
trap 'forward INT 2' INT
trap 'forward HUP 1' HUP

# A background job of a script (no job control) is never a group leader, so setsid does not fork:
# $! is the command itself, and after setsid() its group id is $pid.
setsid "$@" &
pid=$!
[[ -n "$sig" ]] && kill -"$sig_name" "$pid" 2> /dev/null

reap_group() {  # SIGKILL whatever is left in the group, then wait up to 10 s for it to go
  pgrep -g "$pid" > /dev/null || return 0
  kill -KILL -- "-$pid" 2> /dev/null
  for _ in $(seq 50); do pgrep -g "$pid" > /dev/null || return 0; sleep 0.2; done
  echo "stall-guard: group $pid still has processes 10 s after SIGKILL" >&2
}
finish() {  # finish <command status>: empty the group, report, exit (128 + forwarded signal)
  local until_ms ended_ms
  if pgrep -g "$pid" > /dev/null; then
    ended_ms=$(now_ms)
    # The command ended but its group did not: after a forwarded signal the group gets until
    # KILL_AFTER past the signal, otherwise 5 s; then SIGKILL, so nothing runs into the rerun.
    if [[ -n "$sig" ]]; then until_ms=$(( sig_at + KILL_AFTER * 1000 )); else until_ms=$(( $(now_ms) + 5000 )); fi
    while pgrep -g "$pid" > /dev/null && (( $(now_ms) < until_ms )); do sleep 0.2; done
    if pgrep -g "$pid" > /dev/null; then
      echo "stall-guard: processes left in group $pid after the command ended; SIGKILL" >&2
      reap_group
    fi
    echo "stall-guard: group empty $(( $(now_ms) - ended_ms )) ms after the command ended" >&2
  fi
  echo "stall-guard: longest quiet gap $(( max_quiet / 1000 ))s (limit ${STALL_S}s)" >&2
  [[ -n "$sig" ]] && exit $(( 128 + sig ))
  exit "$1"
}

last_size=$(size)
last_change=$(now_ms)
while :; do
  if [[ -n "$sig" ]]; then sleep 1 & else sleep "$POLL" & fi
  timer=$!
  ended=""
  # Returns when the command or the timer ends (or a trapped signal interrupts the wait).
  wait -n -p ended "$pid" "$timer" 2> /dev/null
  st=$?
  # A trapped signal that interrupts `wait -n -p` leaves `ended` unset (set -u): read it with :-
  if [[ "${ended:-}" == "$pid" ]]; then
    kill "$timer" 2> /dev/null
    finish "$st"
  fi
  if ! kill -0 "$pid" 2> /dev/null; then   # ended while we were not waiting on it
    kill "$timer" 2> /dev/null
    wait "$pid"
    finish $?
  fi
  [[ "${ended:-}" == "$timer" ]] || kill "$timer" 2> /dev/null   # a signal cut the wait short
  s=$(size)
  now=$(now_ms)
  if [[ -n "$sig" ]] && (( now - sig_at >= KILL_AFTER * 1000 )); then
    echo "stall-guard: group $pid still running ${KILL_AFTER}s after a forwarded signal; SIGKILL" >&2
    kill -KILL -- "-$pid" 2> /dev/null
  fi
  (( now - last_change > max_quiet )) && max_quiet=$(( now - last_change ))
  if [[ "$s" != "$last_size" ]]; then
    last_size=$s
    last_change=$now
  elif [[ -z "$sig" ]] && (( now - last_change >= STALL_S * 1000 )) && kill -0 "$pid" 2> /dev/null; then
    # (After a forwarded signal the stop is that signal's, reported as 128 + it, not a stall.)
    echo "stall-guard: $LOG did not grow for $(( (now - last_change) / 1000 ))s; killing group $pid" >&2
    kill -KILL -- "-$pid" 2> /dev/null
    wait "$pid" 2> /dev/null
    # wait reaps only the direct child; return once the whole group is gone (at most 10 s), so
    # nothing from the stalled part runs into the rerun.
    reap_group
    exit 75
  fi
done
