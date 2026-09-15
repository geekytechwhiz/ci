#!/bin/bash
# Thin entrypoint: Recover-Data stage (execute after manual approval).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bootstrap-framework.sh
source "$SCRIPT_DIR/bootstrap-framework.sh"
# shellcheck source=common.sh
source "${CICD_SCRIPTS_DIR}/common.sh"

assert_stage
export DATA_RECOVERY_PHASE=execute
export RECOVERY_STATUS="${RECOVERY_STATUS:-APPROVAL_GRANTED}"
export RECOVERY_SUCCESS=false

# Prefer secondary DataPreflightArtifact when present (CodePipeline)
if [ -n "${CODEBUILD_SRC_DIR_DataPreflightArtifact:-}" ]; then
  SECONDARY="${CODEBUILD_SRC_DIR_DataPreflightArtifact}"
  echo "DataPreflightArtifact directory: ${SECONDARY}"
  for rel in \
    deployment-data-preflight.env \
    deployment-data-recovery.env \
    "apps/${SERVICE_NAME}/deployment-data-preflight.env" \
    "apps/${SERVICE_NAME}/deployment-data-recovery.env"
  do
    if [ -f "${SECONDARY}/${rel}" ]; then
      dest_name="$(basename "$rel")"
      dest="${CODEBUILD_SRC_DIR:-.}/${dest_name}"
      if [ -n "${DATA_PREFLIGHT_ENV:-}" ] && [ "$dest_name" = "deployment-data-preflight.env" ]; then
        dest="${CODEBUILD_SRC_DIR:-.}/${DATA_PREFLIGHT_ENV}"
        mkdir -p "$(dirname "$dest")"
      fi
      if [ -n "${DATA_RECOVERY_ENV:-}" ] && [ "$dest_name" = "deployment-data-recovery.env" ]; then
        dest="${CODEBUILD_SRC_DIR:-.}/${DATA_RECOVERY_ENV}"
        mkdir -p "$(dirname "$dest")"
      fi
      cp "${SECONDARY}/${rel}" "$dest"
      echo "Copied ${rel} → ${dest}"
    fi
  done
fi

"${CICD_SCRIPTS_DIR}/data-recovery.sh"

export RECOVERY_SUCCESS=true
export DATA_ACTION=RECOVERY_REQUIRED
RESULT_ENV="$(resolve_data_recovery_result_env)"
write_sourcable_env "$RESULT_ENV" RECOVERY_SUCCESS DATA_ACTION CURRENT_COMMIT
echo "RECOVERY_SUCCESS=${RECOVERY_SUCCESS}"
