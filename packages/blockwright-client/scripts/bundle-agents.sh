#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
VERSION=$(node -p "require(process.argv[1]).version" "$REPO_ROOT/packages/blockwright-client/package.json")
AGENTS_DIR="$REPO_ROOT/packages/blockwright-client/dist/agents"
rm -rf "$AGENTS_DIR"
mkdir -p "$AGENTS_DIR"
for project in neoforge-agent coverage-report; do
  case "$project" in
    neoforge-agent) name="blockwright-neoforge-agent-$VERSION.jar" ;;
    coverage-report) name="blockwright-coverage-$VERSION.jar" ;;
  esac
  jar="$REPO_ROOT/$project/build/libs/$name"
  test -s "$jar" || { echo "Missing required artifact: $jar" >&2; exit 1; }
  cp "$jar" "$AGENTS_DIR/$name"
done
