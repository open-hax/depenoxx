#!/usr/bin/env bash
set -euo pipefail

# CI lint script for depenoxx

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Running lints..."

# Shellcheck for shell scripts
if command -v shellcheck &>/dev/null; then
  for f in scripts/*.sh; do
    shellcheck "$f"
  done
  echo "✓ shellcheck passed"
fi

# Actionlint for GitHub Actions
if command -v actionlint &>/dev/null; then
  actionlint .github/workflows/*.yml
  echo "✓ actionlint passed"
fi

echo "All lints passed!"
