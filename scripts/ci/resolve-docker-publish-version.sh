#!/usr/bin/env bash
# Resolve the Docker tag/channel for a docker-publish workflow event.
#
# Usage:
#   resolve-docker-publish-version.sh EVENT_NAME REF_TYPE REF_NAME
#
# Outputs exactly one safe tag string:
# - push tag: tag without a leading v
# - workflow_dispatch: same as a push of the selected ref
# - push main: latest
# - release: release tag without a leading v
# Any other branch fails: the fork publishes no :next channel.
set -euo pipefail

EVENT_NAME="${1:?event name required}"
REF_TYPE="${2:-}"
REF_NAME="${3:-}"

case "$EVENT_NAME" in
  push | workflow_dispatch)
    if [ "$REF_TYPE" = "tag" ]; then
      VERSION="${REF_NAME#v}"
    else
      case "$REF_NAME" in
        main)
          VERSION="latest"
          ;;
        *)
          echo "Unsupported Docker publish branch: $REF_NAME" >&2
          exit 1
          ;;
      esac
    fi
    ;;
  release)
    VERSION="${REF_NAME#v}"
    ;;
  *)
    VERSION="${REF_NAME#v}"
    ;;
esac

if ! printf '%s' "$VERSION" | grep -qE '^[A-Za-z0-9._-]+$'; then
  echo "Refusing to use unsafe VERSION value: $VERSION" >&2
  exit 1
fi

printf '%s\n' "$VERSION"
