#!/bin/bash
# Thin entrypoint: Deploy-Data stage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bootstrap-framework.sh
source "$SCRIPT_DIR/bootstrap-framework.sh"
# shellcheck source=common.sh
source "${CICD_SCRIPTS_DIR}/common.sh"

assert_stage
export DATA_RECOVERY_PHASE="${DATA_RECOVERY_PHASE:-prepare}"

PREFLIGHT_ENV="$(resolve_data_preflight_env)"
RECOVERY_ENV="$(resolve_data_recovery_env)"

export DATA_ACTION="${DATA_ACTION:-unknown}"
export DATA_REASON="${DATA_REASON:-}"
export RECOVERY_REQUIRED=false
export RECOVERY_CHANGE_SET_NAME="${RECOVERY_CHANGE_SET_NAME:-}"
export RECOVERY_STACK_NAME="${DATA_STACK_NAME}"
export RECOVERY_TABLE_NAME="${DATA_TABLE_NAME}"
export RECOVERY_STAGE="${STAGE}"

"${CICD_SCRIPTS_DIR}/data-preflight.sh"

if [ ! -f "$PREFLIGHT_ENV" ]; then
  echo "ERROR: Data preflight did not write $PREFLIGHT_ENV"
  exit 1
fi

echo "=== primary deployment-data-preflight.env ==="
cat "$PREFLIGHT_ENV"
set -a
# shellcheck disable=SC1090
source "$PREFLIGHT_ENV"
set +a

export DATA_ACTION="${DATA_ACTION:-unknown}"
export DATA_REASON="${DATA_STOP_REASON:-${DATA_ACTION}}"
export RECOVERY_REQUIRED=false
export RECOVERY_CHANGE_SET_NAME=""
export RECOVERY_STACK_NAME="${DATA_STACK_NAME}"
export RECOVERY_TABLE_NAME="${DATA_TABLE_NAME}"
export RECOVERY_STAGE="${STAGE}"

case "${DATA_ACTION:-}" in
  UPDATE|CREATE)
    echo "DATA_ACTION=${DATA_ACTION}: continuing to CloudFormation ${DATA_ACTION}"
    "${CICD_SCRIPTS_DIR}/deploy-data.sh"
    export DATA_ACTION
    export DATA_REASON="${DATA_ACTION}"
    export RECOVERY_REQUIRED=false
    ;;
  RECOVERY_REQUIRED)
    echo "DATA_ACTION=RECOVERY_REQUIRED: routing to controlled recovery prepare"
    export DATA_RECOVERY_PHASE=prepare
    "${CICD_SCRIPTS_DIR}/data-recovery.sh"
    if [ ! -f "$RECOVERY_ENV" ]; then
      echo "ERROR: Recovery preparation did not write $RECOVERY_ENV"
      export DATA_ACTION=STOP
      export RECOVERY_REQUIRED=false
      exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$RECOVERY_ENV"
    set +a
    export DATA_ACTION=RECOVERY_REQUIRED
    export DATA_REASON="${DATA_REASON:-stack missing; existing table ownership verified}"
    export RECOVERY_REQUIRED=true
    export RECOVERY_CHANGE_SET_NAME="${RECOVERY_CHANGE_SET_NAME:-${CHANGE_SET_NAME:-}}"
    export RECOVERY_STACK_NAME="${RECOVERY_STACK_NAME:-${DATA_STACK_NAME}}"
    export RECOVERY_TABLE_NAME="${RECOVERY_TABLE_NAME:-${DATA_TABLE_NAME}}"
    export RECOVERY_STAGE="${RECOVERY_STAGE:-${STAGE}}"
    if [ -z "${RECOVERY_CHANGE_SET_NAME}" ]; then
      echo "ERROR: Recovery change set name is empty."
      export DATA_ACTION=STOP
      export RECOVERY_REQUIRED=false
      exit 1
    fi
    echo "RECOVERY_REQUIRED=true RECOVERY_CHANGE_SET_NAME=${RECOVERY_CHANGE_SET_NAME}"
    echo "Deploy-Data exiting 0 so CodePipeline can reach Approve-Data-Recovery"
    ;;
  STOP)
    echo "ERROR: DATA_ACTION=STOP DATA_STOP_REASON=${DATA_STOP_REASON:-unspecified}"
    export DATA_ACTION=STOP
    export DATA_REASON="${DATA_STOP_REASON:-unspecified}"
    export RECOVERY_REQUIRED=false
    exit 1
    ;;
  *)
    echo "ERROR: Unknown DATA_ACTION=${DATA_ACTION:-}"
    export RECOVERY_REQUIRED=false
    exit 1
    ;;
esac

# Re-export for CodeBuild exported-variables
export DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME
export RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT
echo "Exported DataDeploymentVariables:"
echo "  DATA_ACTION=${DATA_ACTION}"
echo "  RECOVERY_REQUIRED=${RECOVERY_REQUIRED}"
echo "  RECOVERY_CHANGE_SET_NAME=${RECOVERY_CHANGE_SET_NAME:-}"
echo "  CURRENT_COMMIT=${CURRENT_COMMIT:-}"
