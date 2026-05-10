#!/usr/bin/env bash
# Codebase health audit — runs the curated tool set, writes a markdown report
# under .health/, updates .health/last-run.txt with the timestamp + summary.
#
# Verification of which tools are kept lives in .health/spike-results.md.
# Tooling and config rationale: see CLAUDE.md and .dependency-cruiser.cjs.
#
# Run:  bun run health
# Or:   bash scripts/health.sh

set -u  # NOT -e: tools are allowed to exit non-zero (findings are findings)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .health

DATE="$(date +%F)"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
OUT=".health/${DATE}.md"

# --- Tool runs (capture into temp; we'll fold into the report at the end) ---
TMPDIR_HEALTH="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_HEALTH"' EXIT

run_tsc() {
  bun run check >"$TMPDIR_HEALTH/tsc.txt" 2>&1
  echo "$?"
}

run_typecov() {
  bunx -y type-coverage@latest --strict --ignore-catch --at-least 98 \
    >"$TMPDIR_HEALTH/typecov.txt" 2>&1
  echo "$?"
}

run_escape_hatches() {
  grep -rnE '@ts-(ignore|expect-error|nocheck)|\bas any\b|as unknown as' src/ \
    >"$TMPDIR_HEALTH/escape.txt" 2>&1 || true
  wc -l <"$TMPDIR_HEALTH/escape.txt" | tr -d ' '
}

run_depcruise() {
  bunx -y dependency-cruiser@latest "src/**/*.ts" --output-type err \
    >"$TMPDIR_HEALTH/depcruise.txt" 2>&1
  echo "$?"
}

run_knip() {
  bunx -y knip@latest --reporter compact \
    >"$TMPDIR_HEALTH/knip.txt" 2>&1 || true
}

# --- Run them ---
echo "Running health audit (~30-60s)..."
TSC_RC=$(run_tsc)
TYPECOV_RC=$(run_typecov)
ESCAPE_COUNT=$(run_escape_hatches)
DC_RC=$(run_depcruise)
run_knip

# --- Largest source files ---
LARGEST=$(find src -name "*.ts" -not -name "*.test.ts" -exec wc -l {} + 2>/dev/null \
  | sort -rn | head -16)

# --- Extract summary numbers ---
TYPECOV_LINE=$(grep -oE '[0-9]+\.[0-9]+%' "$TMPDIR_HEALTH/typecov.txt" | head -1)
DC_SUMMARY=$(grep -E '^✘|x [0-9]+ dependency violations' "$TMPDIR_HEALTH/depcruise.txt" | head -1)
KNIP_TOTALS=$(grep -E 'Unused (files|exports|dependencies|types)' "$TMPDIR_HEALTH/knip.txt" | head -10)

# --- Write report ---
{
  echo "# Samsinn health — $TS"
  echo
  echo "## Summary"
  echo
  echo "- Typecheck: $([ "$TSC_RC" = 0 ] && echo '✅ pass' || echo '❌ fail')"
  echo "- Type coverage: ${TYPECOV_LINE:-unknown}"
  echo "- Escape hatches (\`as any\` / \`@ts-ignore\` etc): $ESCAPE_COUNT"
  echo "- Dependency-cruiser: ${DC_SUMMARY:-no violations}"
  echo
  echo "## 1. Typecheck (bun run check)"
  echo '```'
  tail -5 "$TMPDIR_HEALTH/tsc.txt"
  echo '```'
  echo
  echo "## 2. Type coverage"
  echo '```'
  tail -3 "$TMPDIR_HEALTH/typecov.txt"
  echo '```'
  echo
  echo "## 3. Escape hatches"
  echo '```'
  if [ "$ESCAPE_COUNT" -gt 0 ]; then
    head -30 "$TMPDIR_HEALTH/escape.txt"
    [ "$ESCAPE_COUNT" -gt 30 ] && echo "... ($ESCAPE_COUNT total)"
  else
    echo "clean"
  fi
  echo '```'
  echo
  echo "## 4. Dependency cycles + boundaries (dependency-cruiser)"
  echo '```'
  tail -60 "$TMPDIR_HEALTH/depcruise.txt"
  echo '```'
  echo
  echo "## 5. Dead exports (knip)"
  echo '```'
  head -80 "$TMPDIR_HEALTH/knip.txt"
  echo '```'
  echo
  echo "## 6. Largest source files"
  echo '```'
  echo "$LARGEST"
  echo '```'
} >"$OUT"

# --- Update last-run.txt (one-line summary for SessionStart hook) ---
{
  echo "$TS"
  echo "tsc: $([ "$TSC_RC" = 0 ] && echo pass || echo FAIL) · type-cov: ${TYPECOV_LINE:-?} · escape-hatches: $ESCAPE_COUNT · dep-cruiser: ${DC_SUMMARY:-clean}"
  echo "Full report: $OUT"
} >.health/last-run.txt

echo
echo "Health report → $OUT"
cat .health/last-run.txt
