#!/usr/bin/env bash
# Resolve the git ref the docker-publish `build` job checks out.
#
# Usage:
#   resolve-docker-source-ref.sh EVENT_NAME VERSION SHA [PACKAGE_JSON]
#
# Prints one line (possibly empty):
# - non-dispatch events: empty — actions/checkout then uses the triggering ref.
# - workflow_dispatch with a `v<VERSION>` tag on origin: refs/tags/v<VERSION>.
# - workflow_dispatch without that tag (forks that do not mirror upstream tags):
#   SHA, but only when PACKAGE_JSON (the dispatched commit's) declares VERSION, so an
#   image is never published under a version its source does not carry.
# Exits non-zero when neither holds.
set -euo pipefail

EVENT_NAME="${1:?event name required}"
VERSION="${2:-}"
SHA="${3:-}"
PACKAGE_JSON="${4:-package.json}"

if [ "$EVENT_NAME" != "workflow_dispatch" ]; then
  printf '\n'
  exit 0
fi

if [ -z "$VERSION" ]; then
  echo "::error::workflow_dispatch needs a version input." >&2
  exit 1
fi

TAG_REF="refs/tags/v${VERSION}"
if [ -n "$(git ls-remote --tags --refs origin "$TAG_REF")" ]; then
  printf '%s\n' "$TAG_REF"
  exit 0
fi

PKG_VERSION=""
if [ -f "$PACKAGE_JSON" ]; then
  PKG_VERSION=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? ""))' "$PACKAGE_JSON")
fi

if [ -n "$SHA" ] && [ "$PKG_VERSION" = "$VERSION" ]; then
  echo "::warning::Tag v${VERSION} not found on origin; building the dispatched commit ${SHA} (its package.json is ${PKG_VERSION})." >&2
  printf '%s\n' "$SHA"
  exit 0
fi

echo "::error::Tag v${VERSION} not found on origin, and the dispatched commit's package.json is '${PKG_VERSION}', not '${VERSION}'. Push the v${VERSION} tag, or dispatch from a ref whose package.json is ${VERSION}." >&2
exit 1
