#!/usr/bin/env bash
# Publish every @stimulir/code-runtime-* package to GitHub Packages.
#
# Prereq: a GitHub Personal Access Token with `write:packages` scope.
# Export it as GITHUB_TOKEN before running, OR run the publish-stimulir
# GitHub Actions workflow (manual dispatch) which uses the
# auto-provisioned token.
#
# Usage:
#   GITHUB_TOKEN=ghp_… ./scripts/publish-stimulir.sh
#   GITHUB_TOKEN=ghp_… ./scripts/publish-stimulir.sh @stimulir/code-runtime-pi   # one pkg
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN is not set."
  echo "  Create a PAT with 'write:packages' scope at:"
  echo "    https://github.com/settings/tokens/new?scopes=write:packages"
  echo "  Then: export GITHUB_TOKEN=<token> && $0"
  exit 1
fi

# Materialise .npmrc scoped to @stimulir + GitHub Packages.
NPMRC="$ROOT_DIR/.npmrc.publish"
cat > "$NPMRC" <<EOF
@stimulir:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
always-auth=true
EOF
trap "rm -f '$NPMRC'" EXIT

FILTER="${1:-./registry/stimulir/*}"

# Build the @stimulir packages with `...` to include all their transitive
# dependencies in dependency order. Avoids upstream packages with broken
# build steps (e.g. agent-os-opencode bun lockfile drift) when they're
# not on the publish path.
echo "==> Building @stimulir/* + transitive deps…"
pnpm --filter "@stimulir/*..." build || {
  echo "WARN: some transitive builds failed (likely upstream)."
  echo "      Continuing — pnpm publish will skip packages without dist/."
}

echo ""
echo "==> Publishing packages matching: $FILTER"
pnpm --filter "$FILTER" publish \
  --no-git-checks \
  --access restricted \
  --userconfig "$NPMRC"

echo ""
echo "==> Done. Packages should be live at:"
echo "    https://github.com/stimulir/code-runtime/packages"
