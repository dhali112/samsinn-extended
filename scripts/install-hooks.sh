#!/usr/bin/env bash
# One-shot install: point git at the tracked hooks directory.
#
# Uses `git config core.hooksPath` rather than copying into .git/hooks/ so
# that:
#   1. Hooks stay version-controlled (live under scripts/hooks/).
#   2. Worktrees inherit them automatically (the alternative — copy to
#      .git/hooks/ — fails in worktrees because .git is a file, not a dir).
#
# Idempotent: re-running just confirms the config.
#
# Run:  bash scripts/install-hooks.sh

set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d scripts/hooks ]; then
  echo "Error: scripts/hooks/ not found. Are you in the repo root?"
  exit 1
fi

chmod +x scripts/hooks/*

CURRENT="$(git config --get core.hooksPath || echo '')"
if [ "$CURRENT" = "scripts/hooks" ]; then
  echo "✅ core.hooksPath already set to scripts/hooks (no change)"
else
  git config core.hooksPath scripts/hooks
  echo "✅ git core.hooksPath → scripts/hooks"
  if [ -n "$CURRENT" ]; then
    echo "   (was: $CURRENT)"
  fi
fi

echo
echo "Active hooks:"
ls scripts/hooks/ | grep -v '\.md$' | sed 's/^/  /'
echo
echo "To uninstall:  git config --unset core.hooksPath"
