#!/bin/bash
# Manual application health check (not a CodePipeline stage).
#
# URL resolution order:
#   1. API_BASE_URL (or SERVICE_BASE_URL)
#   2. API_BASE_URL_PARAMETER (full SSM path)
#   3. ${SSM_PREFIX}/api-base-url
#   4. CloudFormation output ServiceEndpoint on APP_STACK_NAME
#
# HEALTH_CHECK_PATH (default /health)
# HEALTH_RESPONSE_CONTAINS (optional exact substring; else status:"healthy" regex)
# SMOKE_TEST_MODE=optional → exit 0 when no URL can be resolved

set -euo pipefail

echo "======================================="
echo "SMOKE TEST"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${AWS_REGION:?AWS_REGION must be set}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

HEALTH_PATH="${HEALTH_CHECK_PATH:-${SMOKE_HEALTH_PATH:-/health}}"
SMOKE_MAX_TIME="${SMOKE_MAX_TIME:-30}"
SMOKE_TEST_MODE="${SMOKE_TEST_MODE:-required}"
HEALTH_RESPONSE_CONTAINS="${HEALTH_RESPONSE_CONTAINS:-}"

api_url="${API_BASE_URL:-${SERVICE_BASE_URL:-}}"

if [ -z "$api_url" ] && [ -n "${API_BASE_URL_PARAMETER:-}" ]; then
  api_url="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$API_BASE_URL_PARAMETER" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || true)"
fi

if [ -z "$api_url" ] || [ "$api_url" = "None" ]; then
  api_url="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$SSM_PREFIX/api-base-url" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || true)"
fi

if [ -z "$api_url" ] || [ "$api_url" = "None" ]; then
  api_url="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$APP_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='ServiceEndpoint'].OutputValue | [0]" \
    --output text 2>/dev/null || true)"
fi

if [ -z "$api_url" ] || [ "$api_url" = "None" ]; then
  if [ "$SMOKE_TEST_MODE" = "optional" ]; then
    echo "WARN: Could not resolve application URL and SMOKE_TEST_MODE=optional — skipping."
    exit 0
  fi
  echo "ERROR: Could not resolve application URL."
  echo "Set API_BASE_URL, API_BASE_URL_PARAMETER, SSM ${SSM_PREFIX}/api-base-url, or stack output ServiceEndpoint."
  exit 1
fi

api_url="${api_url%/}"
url="${api_url}${HEALTH_PATH}"

echo "GET $url"
echo "Timeout: ${SMOKE_MAX_TIME}s"

set +e
body="$(curl --fail --silent --show-error --max-time "$SMOKE_MAX_TIME" "$url")"
curl_rc=$?
set -e

if [ "$curl_rc" -ne 0 ]; then
  echo "ERROR: Health check failed (curl exit ${curl_rc})"
  echo "Endpoint unreachable, timed out, or returned an HTTP error: $url"
  exit 1
fi

echo "$body"

if [ -n "$HEALTH_RESPONSE_CONTAINS" ]; then
  if ! printf '%s' "$body" | grep -Fq "$HEALTH_RESPONSE_CONTAINS"; then
    echo "ERROR: Health response did not contain expected substring: ${HEALTH_RESPONSE_CONTAINS}"
    exit 1
  fi
else
  if ! printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"'; then
    echo "ERROR: Health response did not contain status \"healthy\""
    exit 1
  fi
fi

echo "======================================="
echo "SMOKE TEST PASSED"
echo "======================================="
