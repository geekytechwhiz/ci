#!/bin/bash
# Record a successful pipeline run as the deployment baseline.
#
# Writes CI/CD execution state and LAST_* parameters under:
#   /${STAGE}/${SERVICE_NAME}/cicd/*
#
# This is the pipeline identity namespace, not the service SSM contract
# (SSM_PREFIX). LAST_* is advanced only after enabled stacks and artifacts
# are verified. A failure must not mark the deployment successful.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

recorded_success=0

trim() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

put_ssm() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter \
    --region "$AWS_REGION" \
    --name "$name" \
    --type String \
    --value "$value" \
    --overwrite
}

on_failure() {
  local rc=$?
  if [ "$recorded_success" -eq 1 ]; then
    exit 0
  fi
  echo "ERROR: Record-Deployment failed; LAST_DEPLOYED_COMMIT was not updated." >&2
  if [ -n "${CURRENT_EXECUTION_STATUS_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_STATUS_PARAM" "FAILED" || true
  fi
  if [ -n "${CURRENT_EXECUTION_STAGE_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_STAGE_PARAM" "Record-Deployment" || true
  fi
  exit "$rc"
}

trap on_failure EXIT

require_inputs() {
  : "${STAGE:?STAGE must be set (dev, stg, or prd)}"
  : "${AWS_REGION:?AWS_REGION must be set}"
  : "${SERVICE_NAME:?SERVICE_NAME must be set}"
  : "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
  : "${LAST_DEPLOYED_COMMIT_PARAM:?LAST_DEPLOYED_COMMIT_PARAM must be set}"
  assert_stage
}

resolve_current_commit() {
  local candidate
  candidate="$(trim "${CURRENT_COMMIT:-}")"
  if is_s3_artifact_ref "$candidate"; then
    echo "ERROR: CURRENT_COMMIT is an S3 artifact ARN/path, not a Git commit SHA." >&2
    echo "CURRENT_COMMIT=$candidate" >&2
    exit 1
  fi
  if ! is_git_sha "$candidate"; then
    echo "ERROR: CURRENT_COMMIT is missing or is not a valid Git commit SHA." >&2
    echo "Record-Deployment requires CURRENT_COMMIT=#{BuildVariables.CURRENT_COMMIT}." >&2
    exit 1
  fi
  CURRENT_COMMIT="$candidate"
}

verify_artifact() {
  local key="$1"
  if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$key" >/dev/null; then
    echo "ERROR: required artifact missing: s3://${ARTIFACT_BUCKET}/${key}" >&2
    return 1
  fi
  echo "[RECORD] verified artifact: s3://${ARTIFACT_BUCKET}/${key}"
}

verify_stack() {
  local stack_name="$1"
  local artifact_uri="$2"
  local enabled="$3"

  if [ "$enabled" != "true" ]; then
    return 0
  fi

  echo "[VERIFY] stack=${stack_name} expected_artifact=${artifact_uri}"
  local stack_status
  stack_status="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' \
    --output text)"

  case "$stack_status" in
    CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE)
      ;;
    *)
      echo "[VERIFY] stack=${stack_name} invalid status=${stack_status}" >&2
      echo "[VERIFY] UPDATE_ROLLBACK_COMPLETE and failed statuses are not a successful deployment." >&2
      return 1
      ;;
  esac

  python3 - "$EVIDENCE_FILE" "$stack_name" "$stack_status" "$artifact_uri" "$CURRENT_COMMIT" <<'PY'
import json, sys
path, stack, status, artifact, commit = sys.argv[1:]
with open(path, encoding="utf-8") as fh:
    evidence = json.load(fh)
evidence[stack] = {
    "stackStatus": status,
    "expectedArtifact": artifact,
    "commit": commit,
    "verified": True,
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(evidence, fh, separators=(",", ":"))
PY
}

main() {
  require_inputs
  resolve_current_commit

  ENABLE_DATA="$(normalize_bool "${ENABLE_DATA:-true}")"
  ENABLE_INFRA="$(normalize_bool "${ENABLE_INFRA:-true}")"
  ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"
  DATA_STACK_NAME="${DATA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-data}"
  INFRA_STACK_NAME="${INFRA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-infra}"
  APP_STACK_NAME="${APP_STACK_NAME:-${STAGE}-${SERVICE_NAME}}"
  PREFIX="${SERVICE_NAME}/${CURRENT_COMMIT}"
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ARTIFACT_URI="s3://${ARTIFACT_BUCKET}/${PREFIX}/"

  echo "Recording successful deployment"
  echo "Service: $SERVICE_NAME"
  echo "Stage: $STAGE"
  echo "Current commit: $CURRENT_COMMIT"
  echo "CI/CD SSM namespace: /${STAGE}/${SERVICE_NAME}/cicd"
  echo "Service SSM contract prefix: ${SSM_PREFIX}"

  if [ "$ENABLE_DATA" = "true" ]; then
    verify_artifact "${PREFIX}/data/packaged.yaml"
  fi
  if [ "$ENABLE_INFRA" = "true" ]; then
    verify_artifact "${PREFIX}/infra/packaged.yaml"
  fi
  if [ "$ENABLE_APP" = "true" ]; then
    verify_artifact "${PREFIX}/app/packaged.yaml"
  fi

  EVIDENCE_FILE="$(mktemp)"
  VERIFICATION_FILE="$(mktemp)"
  printf '%s\n' '{}' > "$EVIDENCE_FILE"

  verify_stack "$DATA_STACK_NAME" "s3://${ARTIFACT_BUCKET}/${PREFIX}/data/packaged.yaml" "$ENABLE_DATA"
  verify_stack "$INFRA_STACK_NAME" "s3://${ARTIFACT_BUCKET}/${PREFIX}/infra/packaged.yaml" "$ENABLE_INFRA"
  verify_stack "$APP_STACK_NAME" "s3://${ARTIFACT_BUCKET}/${PREFIX}/app/packaged.yaml" "$ENABLE_APP"

  python3 - "$EVIDENCE_FILE" "$VERIFICATION_FILE" "$CURRENT_COMMIT" "$NOW" <<'PY'
import json, sys
evidence_path, verification_path, commit, verified_at = sys.argv[1:]
with open(evidence_path, encoding="utf-8") as fh:
    stacks = json.load(fh)
result = {
    "verified": True,
    "commit": commit,
    "verifiedAt": verified_at,
    "stacks": stacks,
}
with open(verification_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, separators=(",", ":"))
PY

  if [ -n "${CURRENT_EXECUTION_COMMIT_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_COMMIT_PARAM" "$CURRENT_COMMIT"
  fi
  if [ -n "${CURRENT_EXECUTION_STAGE_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_STAGE_PARAM" "Record-Deployment"
  fi
  if [ -n "${CURRENT_EXECUTION_STATUS_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_STATUS_PARAM" "SUCCESS"
  fi
  if [ -n "${CURRENT_EXECUTION_TIME_PARAM:-}" ]; then
    put_ssm "$CURRENT_EXECUTION_TIME_PARAM" "$NOW"
  fi
  if [ -n "${DEPLOYMENT_EVIDENCE_PARAM:-}" ]; then
    put_ssm "$DEPLOYMENT_EVIDENCE_PARAM" "$(cat "$EVIDENCE_FILE")"
  fi
  if [ -n "${DEPLOYMENT_VERIFICATION_PARAM:-}" ]; then
    put_ssm "$DEPLOYMENT_VERIFICATION_PARAM" "$(cat "$VERIFICATION_FILE")"
  fi

  put_ssm "$LAST_DEPLOYED_COMMIT_PARAM" "$CURRENT_COMMIT"
  if [ -n "${LAST_DEPLOYED_ARTIFACT_PARAM:-}" ]; then
    put_ssm "$LAST_DEPLOYED_ARTIFACT_PARAM" "$ARTIFACT_URI"
  fi
  if [ -n "${LAST_DEPLOYMENT_STATUS_PARAM:-}" ]; then
    put_ssm "$LAST_DEPLOYMENT_STATUS_PARAM" "SUCCESS"
  fi
  if [ -n "${LAST_DEPLOYMENT_TIME_PARAM:-}" ]; then
    put_ssm "$LAST_DEPLOYMENT_TIME_PARAM" "$NOW"
  fi

  printf 'DEPLOYMENT_STATUS=SUCCESS\nDEPLOYED_COMMIT=%s\nDEPLOYED_ARTIFACT=%s\n' \
    "$CURRENT_COMMIT" "$ARTIFACT_URI" > "${CODEBUILD_SRC_DIR:-.}/deployment-status.env"

  echo "Deployment baseline successfully updated."
  echo "SSM parameter: $LAST_DEPLOYED_COMMIT_PARAM"
  recorded_success=1
  trap - EXIT
}

main
