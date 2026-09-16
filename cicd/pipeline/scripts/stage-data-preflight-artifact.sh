#!/bin/bash
# Stage the CodePipeline DataPreflightArtifact payload.
#
# CodeBuild UPLOAD_ARTIFACTS fails with "no matching artifact paths found"
# when the glob matches nothing. Hidden directories such as
# .pipeline-data-preflight are not matched by CodeBuild's artifact globber.
# Always write a non-hidden directory with at least one file.
set -euo pipefail

SRC_DIR="${CODEBUILD_SRC_DIR:-.}"
ART_DIR="${SRC_DIR}/pipeline-data-preflight"
VARS_ENV="${SRC_DIR}/data-deployment-variables.env"

mkdir -p "$ART_DIR"

if [ -f "$VARS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$VARS_ENV"
  set +a
fi

{
  echo "CURRENT_COMMIT=${CURRENT_COMMIT:-}"
  echo "DATA_ACTION=${DATA_ACTION:-}"
  echo "RECOVERY_REQUIRED=${RECOVERY_REQUIRED:-false}"
  echo "RECOVERY_CHANGE_SET_NAME=${RECOVERY_CHANGE_SET_NAME:-}"
  echo "RECOVERY_STACK_NAME=${RECOVERY_STACK_NAME:-}"
  echo "RECOVERY_TABLE_NAME=${RECOVERY_TABLE_NAME:-}"
  echo "RECOVERY_STAGE=${RECOVERY_STAGE:-}"
  echo "DATA_REASON=${DATA_REASON:-}"
} > "${ART_DIR}/data-preflight-artifact.txt"

for f in data-deployment-variables.env deployment-data-preflight.env deployment-data-recovery.env; do
  if [ -f "${SRC_DIR}/$f" ]; then
    cp "${SRC_DIR}/$f" "${ART_DIR}/"
  elif [ -f "$f" ]; then
    cp "$f" "${ART_DIR}/"
  fi
done

if [ ! -s "${ART_DIR}/data-preflight-artifact.txt" ]; then
  echo "ERROR: failed to stage DataPreflightArtifact marker" >&2
  exit 1
fi

echo "Staged DataPreflightArtifact in ${ART_DIR}:"
ls -la "$ART_DIR"
