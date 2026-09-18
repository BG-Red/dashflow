#!/usr/bin/env bash
# Block commits that contain secrets or tenant-identifying values.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed — install it so this repo stays clean:"
  echo "  macOS:  brew install gitleaks"
  echo "  other:  https://github.com/gitleaks/gitleaks#installing"
  echo "Set ALLOW_MISSING_GITLEAKS=1 to skip this check (not recommended)."
  [[ "${ALLOW_MISSING_GITLEAKS:-0}" == "1" ]] && exit 0
  exit 1
fi

gitleaks git --staged --config .gitleaks.toml --redact --verbose --no-banner
