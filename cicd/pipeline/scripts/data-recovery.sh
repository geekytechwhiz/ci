#!/bin/bash
# Data stack recovery orchestrator for ${STAGE}-${SERVICE_NAME}-data.
#
# Phases:
#   prepare (default) — Deploy-Data when DATA_ACTION=RECOVERY_REQUIRED.
#     Prepares an IMPORT change set and exits 0. Does not execute it.
#   execute           — Recover-Data after CodePipeline Manual Approval.
#     Revalidates the table, executes IMPORT, restores the Data contract.
#
# Does not CloudFormation CREATE (that would target a live table).
# Does not delete, recreate, or modify DynamoDB table data.
# Does not re-run the preflight classifier when the env file exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

assert_stage
assert_codebuild_stage_match

PHASE="${DATA_RECOVERY_PHASE:-prepare}"

log() {
  echo "[DATA-RECOVERY] $*"
}

log_import() {
  echo "[DATA-RECOVERY-IMPORT] $*"
}

log_validate() {
  echo "[DATA-RECOVERY-VALIDATE] $*"
}

log_recovery_identity() {
  log "Service=${OWNERSHIP_TAG_SERVICE}"
  log "Stage=${STAGE}"
  log "CURRENT_COMMIT=${CURRENT_COMMIT:-}"
  log "Stack name=${DATA_STACK_NAME}"
  log "Table name=${DATA_TABLE_NAME}"
  log "Change set name=${CHANGE_SET_NAME:-${RECOVERY_CHANGE_SET_NAME:-}}"
}

immutable_data_artifact_uri() {
  immutable_packaged_template_s3_uri data
}

fail_stop() {
  log "ERROR: $*"
  log "ERROR: DATA_ACTION=STOP. Recovery is halted."
  log "ERROR: The DynamoDB table was not deleted or recreated."
  log "ERROR: Infra and App must not continue."
  exit 1
}

cfn_role_args() {
  cfn_data_recovery_role_args
}

approval_granted() {
  case "${RECOVERY_STATUS:-}" in
    APPROVAL_GRANTED) return 0 ;;
  esac
  case "${RECOVERY_APPROVAL:-}" in
    GRANTED|APPROVED|Approved) return 0 ;;
  esac
  case "${CODEPIPELINE_RECOVERY_APPROVAL:-}" in
    GRANTED|APPROVED|Approved) return 0 ;;
  esac
  case "${CODEPIPELINE_APPROVAL_RESULT:-}" in
    Approved|APPROVED|GRANTED) return 0 ;;
  esac
  if [ "${RECOVERY_REQUIRED:-}" = "true" ] && [ "${DATA_RECOVERY_PHASE:-}" = "execute" ]; then
    return 0
  fi
  return 1
}

describe_stack_status() {
    local output rc status

    echo "[DATA-RECOVERY-CFN] Describing stack: ${DATA_STACK_NAME}" >&2

    set +e
    output="$(
        aws cloudformation describe-stacks \
            --stack-name "${DATA_STACK_NAME}" \
            --region "${AWS_REGION}" \
            --query 'Stacks[0].StackStatus' \
            --output text \
            2>&1
    )"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        if echo "$output" | grep -qiE \
            'does not exist|ValidationError.*does not exist'; then
            echo "[DATA-RECOVERY-CFN] Stack does not exist: ${DATA_STACK_NAME}" >&2
            printf '%s\n' "NOT_FOUND"
            return 0
        fi

        echo "[DATA-RECOVERY-CFN] ERROR: describe-stacks failed." >&2
        echo "[DATA-RECOVERY-CFN] ERROR: Stack=${DATA_STACK_NAME}" >&2
        echo "[DATA-RECOVERY-CFN] ERROR: Region=${AWS_REGION}" >&2
        echo "[DATA-RECOVERY-CFN] ERROR: AWS response:" >&2
        echo "${output}" >&2
        return "$rc"
    fi

    status="$(printf '%s\n' "$output" | tr -d '\r\n')"

    if [ -z "$status" ] || [ "$status" = "None" ]; then
        echo "[DATA-RECOVERY-CFN] ERROR: CloudFormation returned no stack status." >&2
        echo "[DATA-RECOVERY-CFN] Stack=${DATA_STACK_NAME}" >&2
        return 1
    fi

    echo "[DATA-RECOVERY-CFN] Stack status=${status}" >&2

    printf '%s\n' "$status"
}

workflow_table_managed() {
  local output rc=0 physical type logical

  set +e
  output="$(aws cloudformation describe-stack-resource \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --logical-resource-id "$DATA_LOGICAL_ID" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    return 1
  fi

  type="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).ResourceType) || "");
  ')"
  logical="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).LogicalResourceId) || "");
  ')"
  physical="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).PhysicalResourceId) || "");
  ')"

  if [ "$logical" = "$DATA_LOGICAL_ID" ] \
    && [ "$type" = "AWS::DynamoDB::Table" ] \
    && [ "$physical" = "$DATA_TABLE_NAME" ]; then
    DATA_TABLE_PHYSICAL_ID="$physical"
    return 0
  fi
  return 1
}

revalidate_live_table_and_ownership() {
  local output rc=0 status caller_json caller_account caller_arn ownership_result table_json tags_json tags_failed=0

  log_validate "Re-reading DynamoDB table ${DATA_TABLE_NAME}"
  set +e
  output="$(aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'ResourceNotFoundException|Requested resource not found'; then
      fail_stop "DynamoDB table does not exist (${DATA_TABLE_NAME}). Recovery will not CREATE or recreate the table."
    fi
    log "ERROR: ${output}"
    fail_stop "dynamodb describe-table failed for ${DATA_TABLE_NAME}."
  fi

  table_json="$output"
  status="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableStatus) || "");
  ')"
  TABLE_ARN="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableArn) || "");
  ')"
  TABLE_STREAM_ARN="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).LatestStreamArn) || "");
  ')"

  log_validate "Table exists. TableStatus=${status:-unknown}"
  if [ "$status" != "ACTIVE" ]; then
    fail_stop "Table is not ACTIVE (status=${status:-missing})."
  fi

  set +e
  caller_json="$(aws sts get-caller-identity --output json 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "ERROR: ${caller_json}"
    fail_stop "Required ownership tags cannot be verified."
  fi

  caller_account="$(CALLER_JSON="$caller_json" node -e '
    const i = JSON.parse(process.env.CALLER_JSON);
    process.stdout.write(i.Account || "");
  ')"
  caller_arn="$(CALLER_JSON="$caller_json" node -e '
    const i = JSON.parse(process.env.CALLER_JSON);
    process.stdout.write(i.Arn || "");
  ')"

  tags_json='{"Tags":[]}'
  if [ -n "${TABLE_ARN}" ]; then
    set +e
    tags_json="$(aws dynamodb list-tags-of-resource \
      --region "$AWS_REGION" \
      --resource-arn "$TABLE_ARN" \
      --output json 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      log "ERROR: ${tags_json}"
      tags_failed=1
      tags_json='{"Tags":[]}'
    fi
  else
    tags_failed=1
  fi

  ownership_result="$(
    EXPECTED_TABLE_NAME="$DATA_TABLE_NAME" \
    EXPECTED_LOGICAL_ID="$DATA_LOGICAL_ID" \
    EXPECTED_ACCOUNT="$caller_account" \
    EXPECTED_REGION="$AWS_REGION" \
    EXPECTED_SERVICE="$OWNERSHIP_TAG_SERVICE" \
    EXPECTED_STAGE="$STAGE" \
    EXPECTED_PURPOSE="$OWNERSHIP_TAG_PURPOSE" \
    EXPECTED_MANAGED_BY="$OWNERSHIP_TAG_MANAGED_BY" \
    TABLE_JSON="${table_json}" \
    TAGS_JSON="${tags_json}" \
    TAGS_FAILED="${tags_failed}" \
    CALLER_ARN="$caller_arn" \
    node <<'NODE'
const tableWrap = JSON.parse(process.env.TABLE_JSON || '{}');
const table = tableWrap.Table || {};
const tagsWrap = JSON.parse(process.env.TAGS_JSON || '{"Tags":[]}');
const tags = Array.isArray(tagsWrap.Tags) ? tagsWrap.Tags : [];
const tagMap = {};
for (const t of tags) {
  if (t && t.Key) tagMap[t.Key] = t.Value;
}
const reasons = [];
function parseArn(arn) {
  if (!arn || typeof arn !== 'string') return null;
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return null;
  return { service: parts[2], region: parts[3], account: parts[4], resource: parts.slice(5).join(':') };
}
if (table.TableName !== process.env.EXPECTED_TABLE_NAME) {
  reasons.push(`TableName is '${table.TableName || 'missing'}', expected '${process.env.EXPECTED_TABLE_NAME}'`);
}
const parsed = parseArn(table.TableArn || '');
if (!parsed) {
  reasons.push('Table ARN is missing or not a valid DynamoDB ARN');
} else {
  if (parsed.service !== 'dynamodb') reasons.push(`ARN service is '${parsed.service}', expected dynamodb`);
  if (parsed.region !== process.env.EXPECTED_REGION) reasons.push(`ARN region is '${parsed.region}', expected '${process.env.EXPECTED_REGION}'`);
  if (!process.env.EXPECTED_ACCOUNT) reasons.push('Caller AWS account could not be determined');
  else if (parsed.account !== process.env.EXPECTED_ACCOUNT) reasons.push(`ARN account is '${parsed.account}', expected caller account '${process.env.EXPECTED_ACCOUNT}'`);
  const expectedResource = `table/${process.env.EXPECTED_TABLE_NAME}`;
  if (parsed.resource !== expectedResource) reasons.push(`ARN resource is '${parsed.resource}', expected '${expectedResource}'`);
}
if (process.env.TAGS_FAILED === '1') {
  reasons.push('Resource tags could not be listed');
} else {
  const requiredTags = {
    Service: process.env.EXPECTED_SERVICE,
    Stage: process.env.EXPECTED_STAGE,
    Purpose: process.env.EXPECTED_PURPOSE,
    ManagedBy: process.env.EXPECTED_MANAGED_BY,
  };
  for (const [key, expected] of Object.entries(requiredTags)) {
    if (!Object.prototype.hasOwnProperty.call(tagMap, key)) {
      reasons.push(`tag ${key} is missing, expected '${expected}'`);
    } else if (tagMap[key] !== expected) {
      reasons.push(`tag ${key} is '${tagMap[key]}', expected '${expected}'`);
    }
  }
}
process.stdout.write(JSON.stringify({ state: reasons.length === 0 ? 'VERIFIED' : 'UNVERIFIED', reasons }));
NODE
  )"

  local ownership_state
  ownership_state="$(RESULT_JSON="$ownership_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "UNVERIFIED");
  ')"
  log_validate "Ownership validation: ${ownership_state} (caller ${caller_arn})"

  if [ "${ownership_state}" != "VERIFIED" ]; then
    RESULT_JSON="$ownership_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const reason of r.reasons || []) {
        console.log("[DATA-RECOVERY-VALIDATE] ERROR: " + reason);
      }
    '
    fail_stop "Required ownership tags do not match for ${DATA_TABLE_NAME}."
  fi
}

read_ssm_parameter() {
  local name="$1"
  local output rc=0
  set +e
  output="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$name" \
    --query 'Parameter.Value' \
    --output text 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ -z "${output}" ] || [ "${output}" = "None" ]; then
    log "ERROR: ${output}"
    fail_stop "Required SSM parameter ${name} is missing or empty."
  fi
  printf '%s' "$output"
}

validate_ssm_contract() {
  local ssm_name ssm_arn ssm_stream

  log_validate "Validating Data SSM contract under ${SSM_PREFIX}"
  ssm_name="$(read_ssm_parameter "${SSM_PREFIX}/TABLE_NAME")"
  ssm_arn="$(read_ssm_parameter "${SSM_PREFIX}/TABLE_ARN")"
  ssm_stream="$(read_ssm_parameter "${SSM_PREFIX}/STREAM_ARN")"

  log_validate "TABLE_NAME=${ssm_name}"
  log_validate "TABLE_ARN=${ssm_arn}"
  log_validate "STREAM_ARN=${ssm_stream}"

  if [ "${ssm_name}" != "${DATA_TABLE_NAME}" ]; then
    fail_stop "SSM TABLE_NAME is '${ssm_name}', expected '${DATA_TABLE_NAME}'."
  fi
  if [ -n "${TABLE_ARN:-}" ] && [ "${ssm_arn}" != "${TABLE_ARN}" ]; then
    fail_stop "SSM TABLE_ARN is '${ssm_arn}', expected '${TABLE_ARN}'."
  fi
  if [ -n "${TABLE_STREAM_ARN:-}" ] && [ "${ssm_stream}" != "${TABLE_STREAM_ARN}" ]; then
    fail_stop "SSM STREAM_ARN is '${ssm_stream}', expected '${TABLE_STREAM_ARN}'."
  fi
  if [ -z "${ssm_arn}" ] || [ -z "${ssm_stream}" ]; then
    fail_stop "SSM TABLE_ARN or STREAM_ARN is empty."
  fi
  log "SSM contract validated"
  RECOVERY_SUCCESS=true
}

confirm_immutable_artifact() {
  local uri rc=0 dest

  if [ -z "${CURRENT_COMMIT:-}" ]; then
    fail_stop "CURRENT_COMMIT is missing. Recovery requires s3://\$ARTIFACT_BUCKET/\${SERVICE_NAME}/\$CURRENT_COMMIT/data/packaged.yaml."
  fi
  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    fail_stop "CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path."
  fi
  if ! uri="$(immutable_packaged_template_s3_uri data)"; then
    fail_stop "Cannot resolve immutable Data artifact URI for CURRENT_COMMIT=${CURRENT_COMMIT}."
  fi
  dest="$(mktemp "${TMPDIR:-/tmp}/data-packaged.XXXXXX")"
  set +e
  fetch_immutable_packaged_template data "$dest"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ ! -s "$dest" ]; then
    fail_stop "Immutable S3 Data packaged.yaml is unavailable: ${uri}. DATA_STOP_REASON=ARTIFACT_UNAVAILABLE."
  fi
  rm -f "$dest"
}

write_success_env() {
  local dest tmp
  dest="$(resolve_data_recovery_result_env)"
  mkdir -p "$(dirname "$dest")"
  tmp="${dest}.tmp.$$"
  {
    echo "RECOVERY_STATUS=UPDATE_COMPLETE"
    echo "RECOVERY_SUCCESS=true"
    echo "DATA_STACK_NAME=${DATA_STACK_NAME}"
    echo "DATA_TABLE_NAME=${DATA_TABLE_NAME}"
    echo "CURRENT_COMMIT=${CURRENT_COMMIT}"
  } >"$tmp"
  mv "$tmp" "$dest"
  log "Wrote $dest"
}

run_prepare() {
  echo "======================================="
  echo "DATA STACK CONTROLLED RECOVERY PREPARE"
  echo "======================================="
  log "Recovery required"
  log "Stack is missing but retained DynamoDB table exists"
  log "DATA_RECOVERY_PHASE=prepare. IMPORT will not be executed."
  log_recovery_identity
  log "Preparing IMPORT change set"
  assume_data_recovery_role_if_configured
  "$SCRIPT_DIR/prepare-data-recovery.sh"

  RECOVERY_ENV="$(resolve_data_recovery_env)"
  if [ -f "$RECOVERY_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$RECOVERY_ENV"
    set +a
  fi
  if [ -z "${RECOVERY_CHANGE_SET_NAME:-${CHANGE_SET_NAME:-}}" ]; then
    fail_stop "Recovery change set name is empty. It is not approval-ready."
  fi

  log "IMPORT change set is approval-ready"
  log_recovery_identity
  log "Waiting for manual approval"
  echo "======================================="
  echo "DATA STACK RECOVERY PREPARATION COMPLETED"
  echo "======================================="
}

run_execute() {
  local stack_status
  local skip_import=0

  echo "======================================="
  echo "DATA STACK CONTROLLED RECOVERY EXECUTE"
  echo "======================================="
  log_import "Approval received; executing IMPORT"

  assume_data_recovery_role_if_configured

  PREFLIGHT_ENV="$(resolve_data_preflight_env)"
  RECOVERY_ENV="$(resolve_data_recovery_env)"

  if [ -f "$PREFLIGHT_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$PREFLIGHT_ENV"
    set +a
    log "Consumed ${PREFLIGHT_ENV}"
  fi
  if [ -f "$RECOVERY_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$RECOVERY_ENV"
    set +a
    log "Consumed ${RECOVERY_ENV}"
  fi

  if [ -n "${RECOVERY_CHANGE_SET_NAME:-}" ] && [ -z "${CHANGE_SET_NAME:-}" ]; then
    CHANGE_SET_NAME="${RECOVERY_CHANGE_SET_NAME}"
  fi
  if [ -n "${RECOVERY_STACK_NAME:-}" ]; then
    DATA_STACK_NAME="${RECOVERY_STACK_NAME}"
  fi
  if [ -n "${RECOVERY_TABLE_NAME:-}" ]; then
    DATA_TABLE_NAME="${RECOVERY_TABLE_NAME}"
  fi

  : "${DATA_STACK_NAME:?DATA_STACK_NAME must be set}"
  : "${DATA_TABLE_NAME:?DATA_TABLE_NAME must be set}"
  : "${CURRENT_COMMIT:?CURRENT_COMMIT must be set}"

  log "DATA_ACTION=${DATA_ACTION:-}"
  log "RECOVERY_REQUIRED=${RECOVERY_REQUIRED:-}"
  log_recovery_identity

  if [ "${DATA_ACTION:-}" != "RECOVERY_REQUIRED" ] && [ "${RECOVERY_REQUIRED:-}" != "true" ]; then
    fail_stop "DATA_ACTION='${DATA_ACTION:-}' is not RECOVERY_REQUIRED. Refusing recovery execution."
  fi
  DATA_ACTION="RECOVERY_REQUIRED"

  if ! approval_granted; then
    fail_stop "Approval has not been granted. execute-change-set was not called."
  fi

  confirm_immutable_artifact
  revalidate_live_table_and_ownership
  log_import "Checking CloudFormation stack state..."
  log_import "Stack=${DATA_STACK_NAME}"
  log_import "Region=${AWS_REGION}"

  # stack_status="$(describe_stack_status)"
  echo "[DATA-RECOVERY-IMPORT] Resolving current CloudFormation stack state..."

if ! stack_status="$(describe_stack_status)"; then
    echo "[DATA-RECOVERY-IMPORT] ERROR: Unable to determine CloudFormation stack state."
    echo "[DATA-RECOVERY-IMPORT] Recovery is stopping before IMPORT execution."
    echo "[DATA-RECOVERY-IMPORT] No CloudFormation change set has been executed."
    exit 1
fi

echo "[DATA-RECOVERY-IMPORT] CloudFormation stack status=${stack_status}"

  log_import "CloudFormation stack state resolved: ${stack_status}"
  stack_status="$(describe_stack_status)"
  log_import "CloudFormation stack status: ${stack_status}"

  if workflow_table_managed; then
    log_import "${DATA_LOGICAL_ID} is already CloudFormation-managed (PhysicalResourceId=${DATA_TABLE_PHYSICAL_ID})."
    skip_import=1
  fi

  if [ "$skip_import" -eq 1 ]; then
    case "$stack_status" in
      UPDATE_COMPLETE|UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
        log_import "IMPORT already complete and Data stack is ${stack_status}. Skipping duplicate import."
        validate_ssm_contract
        write_success_env
        log "Data stack UPDATE_COMPLETE"
        log "Data SSM contract restored"
        log "Recovery completed successfully"
        echo "======================================="
        echo "DATA STACK RECOVERY COMPLETED"
        echo "======================================="
        return 0
        ;;
      IMPORT_COMPLETE)
        log_import "IMPORT_COMPLETE already exists. Skipping duplicate import."
        ;;
      REVIEW_IN_PROGRESS)
        fail_stop "${DATA_LOGICAL_ID} is managed but stack is REVIEW_IN_PROGRESS. Refusing to continue."
        ;;
      *)
        log_import "Stack owns ${DATA_LOGICAL_ID} with status ${stack_status}. Continuing to contract restoration."
        ;;
    esac
  else
    case "$stack_status" in
      IMPORT_COMPLETE|UPDATE_COMPLETE)
        fail_stop "Stack exists (${stack_status}) but ${DATA_LOGICAL_ID} is not managed as expected. Recovery is stopped."
        ;;
      NOT_FOUND|REVIEW_IN_PROGRESS)
        ;;
      *)
        fail_stop "Stack status ${stack_status} is not eligible for IMPORT execution."
        ;;
    esac

    : "${CHANGE_SET_NAME:?CHANGE_SET_NAME must be set}"
    export DATA_ACTION RECOVERY_STATUS=APPROVAL_GRANTED
    export DATA_STACK_NAME CHANGE_SET_NAME CURRENT_COMMIT DATA_TABLE_NAME
    log "Executing IMPORT change set"
    log_import "Executing prepared IMPORT change set ${CHANGE_SET_NAME}"
    "$SCRIPT_DIR/execute-data-recovery.sh"
    log "IMPORT_COMPLETE"
    log_import "IMPORT_COMPLETE"
  fi

  log "Starting normal Data stack UPDATE to restore deployment-contract resources"
  log "Using immutable Data artifact:"
  log "$(immutable_data_artifact_uri)"
  log "Restoring Data stack contract"
  export RECOVERY_STATUS=IMPORT_COMPLETE
  export DATA_STACK_NAME CURRENT_COMMIT DATA_TABLE_NAME
  "$SCRIPT_DIR/complete-data-recovery.sh"
  log "Data stack UPDATE_COMPLETE"
  log "Data SSM contract restored"
  log_validate "SSM contract validated"
  RECOVERY_SUCCESS=true
  write_success_env
  log "Recovery completed successfully"
  echo "======================================="
  echo "DATA STACK RECOVERY COMPLETED"
  echo "======================================="
}

case "$PHASE" in
  prepare)
    run_prepare
    ;;
  execute)
    run_execute
    ;;
  *)
    echo "ERROR: Unknown DATA_RECOVERY_PHASE='${PHASE}'. Expected prepare or execute."
    exit 1
    ;;
esac
