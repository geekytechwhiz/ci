#!/bin/bash
# Deploy Data stack CREATE/UPDATE via deploy-cfn.sh.
# RECOVERY_REQUIRED exits 1 so the buildspec can call recovery prepare.
# STOP fails. Never deletes, recreates, or imports DynamoDB.

set -euo pipefail

echo "======================================="
echo "DATA STACK DEPLOY"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

assert_stage
assert_codebuild_stage_match

cd "$SERVICE_DIR"

PREFLIGHT_ENV="$(resolve_data_preflight_env)"

if [ ! -f "$PREFLIGHT_ENV" ]; then
  echo "No $PREFLIGHT_ENV found. Running primary Data preflight (manual/emergency path)."
  "$SCRIPT_DIR/data-preflight.sh"
fi

if [ ! -f "$PREFLIGHT_ENV" ]; then
  echo "ERROR: Data preflight did not write $PREFLIGHT_ENV"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$PREFLIGHT_ENV"
set +a

echo "Consuming primary Data preflight result from $PREFLIGHT_ENV"
echo "  DATA_ACTION=${DATA_ACTION:-}"
echo "  DATA_STOP_REASON=${DATA_STOP_REASON:-}"
echo "  stack=$DATA_STACK_NAME table=$DATA_TABLE_NAME"

case "${DATA_ACTION:-}" in
  STOP)
    echo "ERROR: Data preflight stopped the deployment."
    echo "ERROR: DATA_ACTION=STOP DATA_STOP_REASON=${DATA_STOP_REASON:-unspecified}"
    echo "ERROR: Infra and App must not continue."
    cat "$PREFLIGHT_ENV"
    exit 1
    ;;
  RECOVERY_REQUIRED)
    echo "ERROR: DATA_ACTION=RECOVERY_REQUIRED"
    echo "ERROR: Normal CloudFormation CREATE is blocked."
    echo "ERROR: Buildspec must route to data-recovery.sh (prepare)."
    echo "ERROR: Do not delete or recreate ${DATA_TABLE_NAME}."
    cat "$PREFLIGHT_ENV"
    exit 1
    ;;
  UPDATE|CREATE)
    ;;
  *)
    echo "ERROR: Unknown DATA_ACTION='${DATA_ACTION:-}'"
    cat "$PREFLIGHT_ENV"
    exit 1
    ;;
esac

if [ "$DATA_ACTION" = "CREATE" ]; then
  # TOCTOU safety guard — not a second full preflight.
  if aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    >/dev/null 2>&1; then
    echo "ERROR: Preflight classified CREATE but table $DATA_TABLE_NAME now exists."
    echo "ERROR: Refusing CloudFormation create. Re-run data-preflight.sh."
    exit 1
  fi
  case "${DATA_STACK_STATUS:-}" in
    ROLLBACK_COMPLETE|CREATE_FAILED|IMPORT_ROLLBACK_COMPLETE|IMPORT_FAILED)
      delete_failed_cfn_stack_record "$DATA_STACK_NAME" "$DATA_STACK_STATUS"
      ;;
  esac
fi

"$SCRIPT_DIR/deploy-cfn.sh" data

if [ -n "${DATA_PACKAGED_TEMPLATE:-}" ]; then
  PACKAGED_TEMPLATE_PATH="${PACKAGED_TEMPLATE_PATH:-$DATA_PACKAGED_TEMPLATE}"
fi
validate_deployed_data_stack "$DATA_STACK_NAME" "${PACKAGED_TEMPLATE_PATH:-$(immutable_packaged_template_local_path data)}"

echo "======================================="
echo "DATA STACK DEPLOY COMPLETED"
echo "======================================="
