#!/bin/bash
# Application health check after Deploy-App.
#
# URL resolution order (no invented SSM parameters):
#   1. API_BASE_URL (or SERVICE_BASE_URL)
#   2. API_BASE_URL_PARAMETER (explicit full SSM path, if the service publishes one)
#   3. CloudFormation output ServiceEndpoint / HttpApiUrl / ApiUrl on APP_STACK_NAME
#   4. CloudFormation AWS::ApiGateway::RestApi physical ID + STAGE
#
# ENABLE_APP=false → skip explicitly.
# Non-2xx fails. Bounded retries. Does not deploy or modify infrastructure.

set -euo pipefail

echo "======================================="
echo "SMOKE TEST"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${AWS_REGION:?AWS_REGION must be set}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

assert_stage

ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"
if [ "$ENABLE_APP" != "true" ]; then
  echo "[SMOKE] ENABLE_APP=false; smoke test skipped intentionally."
  echo "======================================="
  echo "SMOKE TEST SKIPPED"
  echo "======================================="
  exit 0
fi

HEALTH_PATH="${HEALTH_CHECK_PATH:-${SMOKE_HEALTH_PATH:-/health}}"
SMOKE_MAX_TIME="${SMOKE_MAX_TIME:-15}"
SMOKE_MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-5}"
SMOKE_RETRY_SECONDS="${SMOKE_RETRY_SECONDS:-5}"
HEALTH_RESPONSE_CONTAINS="${HEALTH_RESPONSE_CONTAINS:-}"
APP_STACK_NAME="${APP_STACK_NAME:-${STACK_NAME:-${STAGE}-${SERVICE_NAME}}}"

aws_err_file="$(mktemp)"
cleanup() { rm -f "$aws_err_file"; }
trap cleanup EXIT

report_aws_error() {
  local op="$1"
  echo "ERROR: ${op} failed." >&2
  echo "Region: ${AWS_REGION}" >&2
  echo "Stack: ${APP_STACK_NAME}" >&2
  if grep -qi 'AccessDenied' "$aws_err_file"; then
    echo "Reason: AccessDenied" >&2
  fi
  cat "$aws_err_file" >&2
}

cfn_stack_missing() {
  grep -Eqi 'does not exist|ValidationError' "$aws_err_file"
}

resolve_from_explicit_ssm() {
  local value=""
  if [ -z "${API_BASE_URL_PARAMETER:-}" ]; then
    return 1
  fi
  if ! value="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$API_BASE_URL_PARAMETER" \
    --query 'Parameter.Value' \
    --output text 2>"$aws_err_file")"; then
    report_aws_error "ssm get-parameter ${API_BASE_URL_PARAMETER}"
    return 2
  fi
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    return 1
  fi
  printf '%s' "$value"
}

resolve_from_cfn_outputs() {
  local json url
  if ! json="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$APP_STACK_NAME" \
    --output json 2>"$aws_err_file")"; then
    if cfn_stack_missing; then
      return 1
    fi
    report_aws_error "cloudformation describe-stacks ${APP_STACK_NAME}"
    return 2
  fi
  url="$(STACK_JSON="$json" python3 - <<'PY'
import json, os
data = json.loads(os.environ["STACK_JSON"])
outputs = ((data.get("Stacks") or [{}])[0].get("Outputs")) or []
preferred = ("ServiceEndpoint", "HttpApiUrl", "ApiUrl", "ServiceEndpointUrl", "ApiGatewayUrl")
by_key = {o.get("OutputKey"): o.get("OutputValue") for o in outputs if o.get("OutputKey")}
for key in preferred:
    value = by_key.get(key)
    if value:
        print(value)
        raise SystemExit(0)
for key, value in by_key.items():
    lowered = key.lower()
    if value and ("endpoint" in lowered or "url" in lowered or "api" in lowered):
        print(value)
        raise SystemExit(0)
PY
)" || true
  if [ -z "$url" ] || [ "$url" = "None" ]; then
    return 1
  fi
  printf '%s' "$url"
}

resolve_from_rest_api() {
  local api_id
  if ! api_id="$(aws cloudformation describe-stack-resources \
    --region "$AWS_REGION" \
    --stack-name "$APP_STACK_NAME" \
    --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId | [0]" \
    --output text 2>"$aws_err_file")"; then
    if cfn_stack_missing; then
      return 1
    fi
    report_aws_error "cloudformation describe-stack-resources ${APP_STACK_NAME}"
    return 2
  fi
  if [ -z "$api_id" ] || [ "$api_id" = "None" ]; then
    return 1
  fi
  printf 'https://%s.execute-api.%s.amazonaws.com/%s' "$api_id" "$AWS_REGION" "$STAGE"
}

api_url="${API_BASE_URL:-${SERVICE_BASE_URL:-}}"

if [ -z "$api_url" ]; then
  set +e
  resolved=""
  resolved="$(resolve_from_explicit_ssm)"
  ssm_rc=$?
  set -e
  if [ "$ssm_rc" -eq 2 ]; then
    exit 1
  fi
  if [ "$ssm_rc" -eq 0 ] && [ -n "$resolved" ]; then
    api_url="$resolved"
  fi
fi

if [ -z "$api_url" ]; then
  set +e
  resolved="$(resolve_from_cfn_outputs)"
  cfn_rc=$?
  set -e
  if [ "$cfn_rc" -eq 2 ]; then
    exit 1
  fi
  if [ "$cfn_rc" -eq 0 ] && [ -n "$resolved" ]; then
    api_url="$resolved"
  fi
fi

if [ -z "$api_url" ]; then
  set +e
  resolved="$(resolve_from_rest_api)"
  rest_rc=$?
  set -e
  if [ "$rest_rc" -eq 2 ]; then
    exit 1
  fi
  if [ "$rest_rc" -eq 0 ] && [ -n "$resolved" ]; then
    api_url="$resolved"
  fi
fi

if [ -z "$api_url" ] || [ "$api_url" = "None" ]; then
  echo "ERROR: Could not resolve application URL from an authoritative source." >&2
  echo "Looked for API_BASE_URL, API_BASE_URL_PARAMETER, CloudFormation output ServiceEndpoint," >&2
  echo "and AWS::ApiGateway::RestApi on stack ${APP_STACK_NAME}." >&2
  echo "Do not invent an SSM parameter solely for this smoke test." >&2
  exit 1
fi

api_url="${api_url%/}"
url="${api_url}${HEALTH_PATH}"

echo "GET $url"
echo "Timeout per attempt: ${SMOKE_MAX_TIME}s"
echo "Attempts: ${SMOKE_MAX_ATTEMPTS} retry_delay=${SMOKE_RETRY_SECONDS}s"

attempt=1
curl_rc=1
body=""
while [ "$attempt" -le "$SMOKE_MAX_ATTEMPTS" ]; do
  echo "[SMOKE] attempt ${attempt}/${SMOKE_MAX_ATTEMPTS}"
  set +e
  body="$(curl --fail --silent --show-error --max-time "$SMOKE_MAX_TIME" "$url")"
  curl_rc=$?
  set -e
  if [ "$curl_rc" -eq 0 ]; then
    break
  fi
  echo "[SMOKE] attempt ${attempt} failed (curl exit ${curl_rc})"
  if [ "$attempt" -eq "$SMOKE_MAX_ATTEMPTS" ]; then
    echo "ERROR: Health check failed after ${SMOKE_MAX_ATTEMPTS} attempts." >&2
    echo "Endpoint unreachable, timed out, or returned a non-2xx response: $url" >&2
    exit 1
  fi
  sleep "$SMOKE_RETRY_SECONDS"
  attempt=$((attempt + 1))
done

echo "$body"

if [ -n "$HEALTH_RESPONSE_CONTAINS" ]; then
  if ! printf '%s' "$body" | grep -Fq "$HEALTH_RESPONSE_CONTAINS"; then
    echo "ERROR: Health response did not contain expected substring: ${HEALTH_RESPONSE_CONTAINS}" >&2
    exit 1
  fi
else
  if ! printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"'; then
    echo "ERROR: Health response did not contain status \"healthy\"" >&2
    exit 1
  fi
fi

echo "======================================="
echo "SMOKE TEST PASSED"
echo "======================================="
