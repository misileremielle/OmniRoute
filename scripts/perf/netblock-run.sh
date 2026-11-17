#!/usr/bin/env bash
# Stage-2 T4: block new outbound non-loopback connections for one command, then unblock.
#
# Usage: netblock-run.sh -- <command> [args...]
#
# Inserts an iptables OUTPUT rule that REJECTs new (conntrack NEW) connections
# from this user to anywhere but loopback, tagged with a unique comment. A
# systemd-run transient timer deletes exactly that rule after 1h as a fallback;
# a trap on EXIT always deletes the rule and stops the timer unit. The command
# and its arguments come in as "$@" — nothing is interpolated into a string run
# by a shell.
#
# Fail closed: if iptables, the conntrack/comment matches, or systemd-run are
# unusable, exit 90. If the rule is missing right before the command, exit 91.
set -euo pipefail

if [[ "${1:-}" != "--" ]]; then
  echo "usage: netblock-run.sh -- <command> [args...]" >&2
  exit 2
fi
shift
if [[ "$#" -eq 0 ]]; then
  echo "usage: netblock-run.sh -- <command> [args...]" >&2
  exit 2
fi

RUN_ID="perfblock-$(date +%s%N)"
RULE_SPEC=(OUTPUT ! -o lo -m owner --uid-owner "$(id -u)" -m conntrack --ctstate NEW -m comment --comment "$RUN_ID" -j REJECT)
# IPv6 gets the same rule, unless IPv6 is disabled on the host (then there is nothing to block).
IPV6=1
if [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 0)" == "1" ]]; then
  IPV6=0
fi

fail_closed() {
  echo "netblock-run: $1" >&2
  exit 90
}

cleanup() {
  sudo iptables -D "${RULE_SPEC[@]}" >/dev/null 2>&1 || true
  sudo ip6tables -D "${RULE_SPEC[@]}" >/dev/null 2>&1 || true
  sudo systemctl stop "$RUN_ID-v6.timer" >/dev/null 2>&1 || true
  sudo systemctl stop "$RUN_ID-v6.service" >/dev/null 2>&1 || true
  sudo systemctl stop "$RUN_ID.timer" >/dev/null 2>&1 || true
  sudo systemctl stop "$RUN_ID.service" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# An interrupted run (Ctrl-C, timeout, hangup) must also remove the rule now, not after 1h.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

# boat's agent (ascii-agent.service) uploads snapshots and carries the tunnel as its own account;
# blocking that account makes every save fail and every stop be refused. The measured runs must
# use a separate account (boat docs: hosting/firewall, snapshots/stop).
# Fail closed: only the measuring account, never `user`, and only when the agent's account is known.
ME="$(id -un)"
RUNNER="${PERF_RUNNER:-runner}"
[[ "$ME" != "user" ]] || fail_closed "never block 'user' (boat's agent and tunnel)"
[[ "$ME" == "$RUNNER" ]] || fail_closed "run as the measuring account '$RUNNER', not '$ME'"
if [[ "$(systemctl show -p LoadState --value ascii-agent.service 2>/dev/null)" != "loaded" ]]; then
  fail_closed "ascii-agent.service not found: cannot confirm boat's agent account"
fi
AGENT_USER="$(systemctl show -p User --value ascii-agent.service 2>/dev/null)"
[[ "${AGENT_USER:-root}" != "$ME" ]] || fail_closed "'$ME' is the account of ascii-agent.service"

# Preflight: iptables works, the conntrack and comment matches exist, and
# systemd-run can create transient units. Anything missing fails closed.
command -v iptables >/dev/null 2>&1 || fail_closed "iptables not found"
command -v systemd-run >/dev/null 2>&1 || fail_closed "systemd-run not found"
if [[ "$IPV6" == "1" ]]; then
  command -v ip6tables >/dev/null 2>&1 || fail_closed "IPv6 is enabled but ip6tables not found"
fi
command -v sudo >/dev/null 2>&1 || fail_closed "sudo not found"
sudo -n true >/dev/null 2>&1 || fail_closed "passwordless sudo unavailable"
sudo iptables -m conntrack --help >/dev/null 2>&1 || fail_closed "conntrack match unusable"
sudo iptables -m comment --help >/dev/null 2>&1 || fail_closed "comment match unusable"
# A systemd-run probe: a trivial transient unit must start (fail closed if the
# manager, dbus, or sudo policy cannot run one).
if ! sudo systemd-run --unit "${RUN_ID}-probe" --pipe --wait true >/dev/null 2>&1; then
  fail_closed "systemd-run probe failed"
fi

# Install the block rule, arm the 1h fallback removal of exactly this rule, and
# confirm the rule is present before running anything.
sudo iptables -I "${RULE_SPEC[@]}" || fail_closed "could not insert iptables rule"
sudo systemd-run --unit "$RUN_ID" --on-active=1h iptables -D "${RULE_SPEC[@]}" >/dev/null \
  || fail_closed "could not arm fallback timer"
if ! sudo iptables -C "${RULE_SPEC[@]}" >/dev/null 2>&1; then
  fail_closed "rule missing after insert"
fi
if ! sudo systemctl is-active --quiet "$RUN_ID.timer"; then
  fail_closed "fallback timer not active"
fi
if [[ "$IPV6" == "1" ]]; then
  sudo ip6tables -I "${RULE_SPEC[@]}" || fail_closed "could not insert ip6tables rule"
  sudo systemd-run --unit "$RUN_ID-v6" --on-active=1h ip6tables -D "${RULE_SPEC[@]}" >/dev/null \
    || fail_closed "could not arm IPv6 fallback timer"
  sudo ip6tables -C "${RULE_SPEC[@]}" >/dev/null 2>&1 || fail_closed "IPv6 rule missing after insert"
  sudo systemctl is-active --quiet "$RUN_ID-v6.timer" || fail_closed "IPv6 fallback timer not active"
fi

# Checked: the rule is confirmed present right before the measured part starts.
if ! sudo iptables -C "${RULE_SPEC[@]}" >/dev/null 2>&1; then
  echo "netblock-run: rule missing before command" >&2
  exit 91
fi
if [[ "$IPV6" == "1" ]] && ! sudo ip6tables -C "${RULE_SPEC[@]}" >/dev/null 2>&1; then
  echo "netblock-run: IPv6 rule missing before command" >&2
  exit 91
fi

# Run the command; its exit code is the script's exit code (trap still cleans up).
set +e
"$@"
code="$?"
set -e
exit "$code"
