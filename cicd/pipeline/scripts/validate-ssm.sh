#!/bin/bash
# SSM cross-stack contract gate (service-agnostic).
# Uses SSM_PREFIX + REQUIRED_SSM_PARAMS array from common.sh.
# If the required list is empty and no params are configured, pass with warning.

set -euo pipefail

echo "======================================="
echo "SSM VALIDATION"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

echo "Checking parameters under $SSM_PREFIX/"
echo "Region: $AWS_REGION"

if [ ${#REQUIRED_SSM_PARAMS[@]} -eq 0 ]; then
  echo "WARN: REQUIRED_SSM_PARAMETERS is empty — no required SSM contract configured."
  echo "SSM validation skipped (success)."
  echo "======================================="
  echo "SSM VALIDATION PASSED (no required params)"
  echo "======================================="
  exit 0
fi

echo "Required: ${REQUIRED_SSM_PARAMS[*]}"

failed=0
missing_names=()

for name in "${REQUIRED_SSM_PARAMS[@]}"; do
  path="$SSM_PREFIX/$name"
  printf "  %-40s " "$path"
  value="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$path" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || echo "")"
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "MISSING"
    failed=1
    missing_names+=("$path")
  else
    echo "OK"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "ERROR: One or more required SSM parameters are missing or empty:"
  for path in "${missing_names[@]}"; do
    echo "  - $path"
  done
  echo "Application deploy is blocked until required SSM parameters are valid."
  exit 1
fi

echo "======================================="
echo "SSM VALIDATION PASSED"
echo "======================================="
