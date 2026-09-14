#!/bin/bash
# Record a successful pipeline run as the deployment baseline.
#
# Writes CURRENT_COMMIT to:
#   /${STAGE}/${SERVICE_NAME}/cicd/LAST_DEPLOYED_COMMIT
#
# Must only run after Smoke-Test. Does not deploy stacks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

CURRENT_COMMIT="${CURRENT_COMMIT:-}"

usage_error() {
  echo "ERROR: $*" >&2
  exit 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

require_inputs() {
  : "${STAGE:?STAGE must be set (dev, stg, or prd)}"
  : "${AWS_REGION:?AWS_REGION must be set}"
  : "${SERVICE_NAME:?SERVICE_NAME must be set}"
  assert_stage
}

resolve_current_commit() {
  local candidate
  candidate="$(trim "${CURRENT_COMMIT:-}")"
  if is_s3_artifact_ref "$candidate"; then
    echo "ERROR: CURRENT_COMMIT is an S3 artifact ARN/path, not a Git commit SHA." >&2
    echo "CURRENT_COMMIT=$candidate" >&2
    echo "LAST_DEPLOYED_COMMIT will not be updated." >&2
    exit 1
  fi
  if ! is_git_sha "$candidate"; then
    echo "ERROR: CURRENT_COMMIT is missing or is not a valid Git commit SHA." >&2
    echo "Record-Deployment requires CURRENT_COMMIT=#{BuildVariables.CURRENT_COMMIT}." >&2
    echo "LAST_DEPLOYED_COMMIT will not be updated." >&2
    exit 1
  fi
  CURRENT_COMMIT="$candidate"
}

put_last_deployed_commit() {
  aws ssm put-parameter \
    --name "$LAST_DEPLOYED_COMMIT_PARAM" \
    --value "$CURRENT_COMMIT" \
    --type "String" \
    --overwrite \
    --region "$AWS_REGION"
}

main() {
  require_inputs
  resolve_current_commit

  echo "Recording successful deployment"
  echo "Service: $SERVICE_NAME"
  echo "Stage: $STAGE"
  echo "Current commit: $CURRENT_COMMIT"
  echo "SSM parameter: $LAST_DEPLOYED_COMMIT_PARAM"

  put_last_deployed_commit

  echo "Deployment baseline successfully updated."
}

main
