#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CICD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "========================================"
echo "SCANNING FOR HARD-CODED SECRETS / CREDENTIALS"
echo "========================================"

FOUND_ISSUES=0

# Check for AWS secret key patterns (AKIA / 40-char secret keys) in tracking files
if grep -rn -E 'AKIA[0-9A-Z]{16}' "$CICD_ROOT" --exclude-dir=".git" --exclude="*.example" 2>/dev/null; then
  echo "ERROR: Potential AWS Access Key ID found in cicd directory!"
  FOUND_ISSUES=$((FOUND_ISSUES + 1))
fi

if grep -rn -E '(?i)aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}' "$CICD_ROOT" --exclude-dir=".git" 2>/dev/null; then
  echo "ERROR: Potential AWS Secret Access Key found in cicd directory!"
  FOUND_ISSUES=$((FOUND_ISSUES + 1))
fi

if [ $FOUND_ISSUES -eq 0 ]; then
  echo "No hard-coded AWS credentials found."
  echo "======================================="
  echo "Secrets scan PASSED"
  echo "======================================="
else
  echo "Secrets scan FAILED ($FOUND_ISSUES issue(s) detected)"
  exit 1
fi
