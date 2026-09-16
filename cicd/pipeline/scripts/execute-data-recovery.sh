#!/bin/bash
# Execute a prepared CloudFormation IMPORT change set for ${DATA_LOGICAL_ID}.
#
# This is the ONLY component allowed to call execute-change-set for Data
# recovery. ci/prepare-data-recovery.sh creates and validates the change set
# but must not execute it. This script re-describes the change set and
# executes only after explicit approval.
#
# Required:
#   DATA_ACTION=RECOVERY_REQUIRED
#   RECOVERY_STATUS=APPROVAL_GRANTED
#     or an equivalent CodePipeline marker:
#       RECOVERY_APPROVAL=GRANTED|APPROVED
#       CODEPIPELINE_RECOVERY_APPROVAL=GRANTED|APPROVED
#       CODEPIPELINE_APPROVAL_RESULT=Approved
#   DATA_STACK_NAME
#   CHANGE_SET_NAME
#   CURRENT_COMMIT
#
# Does not create SSM parameters.
# Does not perform a normal Data CloudFormation UPDATE/CREATE.
# Those belong to ci/complete-data-recovery.sh (IMPORT_COMPLETE → UPDATE).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"

assert_stage
assert_codebuild_stage_match
assume_data_recovery_role_if_configured


RECOVERY_ENV="$(resolve_data_recovery_env)"
RESULT_ENV="$(resolve_data_recovery_result_env)"

TABLE_JSON=""
TABLE_ARN=""
TABLE_TAGS_FAILED=0
TAGS_JSON='{"Tags":[]}'
DATA_TABLE_PHYSICAL_ID=""
DATA_STACK_STATUS=""

log() {
  echo "[DATA-RECOVERY-EXECUTE] $*"
}

fail_stop() {
  log "ERROR: $*"
  log "ERROR: Recovery execution STOPPED."
  log "ERROR: execute-change-set was not called, or post-import validation failed."
  log "ERROR: The DynamoDB table was not deleted or recreated. SSM parameters were not written."
  log "ERROR: A normal Data UPDATE was not performed."
  print_cfn_failure_diagnostics "${DATA_STACK_NAME:-}"
  exit 1
}

fail_before_execute() {
  log "ERROR: $*"
  log "ERROR: Recovery execution STOPPED before execute-change-set."
  log "ERROR: The prepared change set was not executed."
  log "ERROR: The DynamoDB table was not deleted, recreated, imported, or modified."
  log "ERROR: SSM parameters were not written. A normal Data UPDATE was not performed."
  exit 1
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
  return 1
}

apply_pipeline_overrides() {
  local saved_status="$1"
  local saved_stack="$2"
  local saved_change_set="$3"
  local saved_commit="$4"

  if [ "${saved_status}" = "APPROVAL_GRANTED" ]; then
    RECOVERY_STATUS="APPROVAL_GRANTED"
  fi

  if [ -n "${saved_stack}" ] && [ -n "${DATA_STACK_NAME:-}" ] && [ "${saved_stack}" != "${DATA_STACK_NAME}" ]; then
    fail_before_execute "DATA_STACK_NAME from the environment (${saved_stack}) does not match the recovery env (${DATA_STACK_NAME})."
  fi
  if [ -n "${saved_change_set}" ] && [ -n "${CHANGE_SET_NAME:-}" ] && [ "${saved_change_set}" != "${CHANGE_SET_NAME}" ]; then
    fail_before_execute "CHANGE_SET_NAME from the environment (${saved_change_set}) does not match the recovery env (${CHANGE_SET_NAME})."
  fi
  if [ -n "${saved_commit}" ] && [ -n "${CURRENT_COMMIT:-}" ] && [ "${saved_commit}" != "${CURRENT_COMMIT}" ]; then
    fail_before_execute "CURRENT_COMMIT from the environment (${saved_commit}) does not match the recovery env (${CURRENT_COMMIT})."
  fi

  if [ -n "${saved_stack}" ]; then
    DATA_STACK_NAME="${saved_stack}"
  fi
  if [ -n "${saved_change_set}" ]; then
    CHANGE_SET_NAME="${saved_change_set}"
  fi
  if [ -n "${saved_commit}" ]; then
    CURRENT_COMMIT="${saved_commit}"
  fi
}

write_result_env() {
  local tmp
  mkdir -p "$(dirname "$RESULT_ENV")"
  tmp="${RESULT_ENV}.tmp.$$"
  {
    echo "RECOVERY_STATUS=IMPORT_COMPLETE"
    echo "DATA_STACK_STATUS=IMPORT_COMPLETE"
    echo "DATA_TABLE_MANAGED=true"
    echo "DATA_TABLE_PHYSICAL_ID=${DATA_TABLE_PHYSICAL_ID}"
    echo "RECOVERY_COMMIT=${CURRENT_COMMIT}"
  } >"$tmp"
  mv "$tmp" "$RESULT_ENV"
  log "Wrote $RESULT_ENV"
}

validate_change_set() {
  local change_set_json="$1"
  local validation

  validation="$(
    CHANGE_SET_JSON="$change_set_json" \
    EXPECTED_TABLE="${DATA_TABLE_NAME}" \
    EXPECTED_CHANGE_SET="${CHANGE_SET_NAME}" \
    EXPECTED_LOGICAL_ID="${DATA_LOGICAL_ID}" \
    node <<'NODE'
const cs = JSON.parse(process.env.CHANGE_SET_JSON || '{}');
const errors = [];
const changes = Array.isArray(cs.Changes) ? cs.Changes : [];
const resourceChanges = changes.filter((c) => c && (c.Type === 'Resource' || c.ResourceChange));

if (process.env.EXPECTED_CHANGE_SET && cs.ChangeSetName && cs.ChangeSetName !== process.env.EXPECTED_CHANGE_SET) {
  errors.push(`ChangeSetName is '${cs.ChangeSetName}', expected '${process.env.EXPECTED_CHANGE_SET}'`);
}
if (cs.Status !== 'CREATE_COMPLETE') {
  errors.push(`Status is '${cs.Status || 'missing'}', expected CREATE_COMPLETE`);
}
if (cs.ExecutionStatus !== 'AVAILABLE') {
  errors.push(`ExecutionStatus is '${cs.ExecutionStatus || 'missing'}', expected AVAILABLE`);
}
if (resourceChanges.length !== 1) {
  errors.push(`Resource change count is ${resourceChanges.length}, expected exactly 1`);
}

let importOk = false;
for (const change of resourceChanges) {
  const rc = change.ResourceChange || {};
  const action = rc.Action || '';
  const logical = rc.LogicalResourceId || '';
  const type = rc.ResourceType || '';
  const replacement = rc.Replacement || 'False';

  if (action === 'Add' || action === 'Create') {
    errors.push(`Change set contains Create of ${logical || 'unknown'} (${type || 'unknown'})`);
  }
  if (action === 'Remove' || action === 'Delete') {
    errors.push(`Change set contains Delete of ${logical || 'unknown'} (${type || 'unknown'})`);
  }
  if (replacement === 'True' || replacement === 'Conditional') {
    errors.push(`Change set contains Replace of ${logical || 'unknown'} (Replacement=${replacement})`);
  }
  if (logical !== process.env.EXPECTED_LOGICAL_ID) {
    errors.push(`LogicalResourceId is '${logical || 'missing'}', expected ${process.env.EXPECTED_LOGICAL_ID}`);
  }
  if (type !== 'AWS::DynamoDB::Table') {
    errors.push(`ResourceType is '${type || 'missing'}', expected AWS::DynamoDB::Table`);
  }
  if (action !== 'Import') {
    errors.push(`Action is '${action || 'missing'}', expected Import`);
  }
  if (action === 'Import' && logical === process.env.EXPECTED_LOGICAL_ID && type === 'AWS::DynamoDB::Table') {
    importOk = true;
  }
  if (rc.PhysicalResourceId && rc.PhysicalResourceId !== process.env.EXPECTED_TABLE) {
    errors.push(`PhysicalResourceId is '${rc.PhysicalResourceId}', expected '${process.env.EXPECTED_TABLE}'`);
  }
}

if (!importOk) {
  errors.push(`Change set does not contain the exact expected Import of ${process.env.EXPECTED_LOGICAL_ID}`);
}

process.stdout.write(errors.length ? `NO\n${errors.join('\n')}` : 'YES');
NODE
  )"

  if [ "${validation}" != "YES" ]; then
    printf '%s\n' "${validation}" | sed 's/^/[DATA-RECOVERY-EXECUTE] ERROR: /'
    fail_before_execute "Prepared change set failed machine validation. execute-change-set was not called."
  fi
}

validate_imported_stack() {
  local output rc=0

  log "Validating CloudFormation stack ${DATA_STACK_NAME} after import"
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qi 'does not exist'; then
      fail_stop "CloudFormation stack ${DATA_STACK_NAME} does not exist after import."
    fi
    log "ERROR: ${output}"
    fail_stop "CloudFormation describe-stacks failed for ${DATA_STACK_NAME} after import."
  fi

  DATA_STACK_STATUS="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ -z "${DATA_STACK_STATUS}" ] || [ "${DATA_STACK_STATUS}" = "None" ] || [ "${DATA_STACK_STATUS}" = "DELETE_COMPLETE" ]; then
    fail_stop "CloudFormation stack ${DATA_STACK_NAME} does not exist after import (status=${DATA_STACK_STATUS:-missing})."
  fi

  if [ "${DATA_STACK_STATUS}" != "IMPORT_COMPLETE" ]; then
    fail_stop "Stack status is ${DATA_STACK_STATUS}, expected IMPORT_COMPLETE."
  fi
  log "Stack exists. StackStatus=${DATA_STACK_STATUS}"
}

validate_imported_resource() {
  local output rc=0
  local resource_type logical_id

  log "Validating logical resource ${DATA_LOGICAL_ID} on ${DATA_STACK_NAME}"
  set +e
  output="$(aws cloudformation describe-stack-resource \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --logical-resource-id "$DATA_LOGICAL_ID" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'does not exist|not exist for stack'; then
      fail_stop "Logical resource ${DATA_LOGICAL_ID} does not exist on ${DATA_STACK_NAME} after import."
    fi
    log "ERROR: ${output}"
    fail_stop "cloudformation describe-stack-resource failed for ${DATA_LOGICAL_ID}."
  fi

  resource_type="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).ResourceType) || "");
  ')"
  logical_id="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).LogicalResourceId) || "");
  ')"
  DATA_TABLE_PHYSICAL_ID="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).PhysicalResourceId) || "");
  ')"

  log "Logical ID: ${logical_id:-missing}"
  log "Resource type: ${resource_type:-missing}"
  log "Physical resource ID: ${DATA_TABLE_PHYSICAL_ID:-missing}"

  if [ "${logical_id}" != "${DATA_LOGICAL_ID}" ]; then
    fail_stop "Logical resource ID is '${logical_id:-missing}', expected ${DATA_LOGICAL_ID}."
  fi
  if [ "${resource_type}" != "AWS::DynamoDB::Table" ]; then
    fail_stop "ResourceType is '${resource_type:-missing}', expected AWS::DynamoDB::Table."
  fi
  if [ -z "${DATA_TABLE_PHYSICAL_ID}" ] || [ "${DATA_TABLE_PHYSICAL_ID}" != "${DATA_TABLE_NAME}" ]; then
    fail_stop "PhysicalResourceId is '${DATA_TABLE_PHYSICAL_ID:-missing}', expected table ${DATA_TABLE_NAME}."
  fi
}

validate_imported_table() {
  local output rc=0 status caller_json caller_account caller_arn ownership_result

  log "Validating DynamoDB table ${DATA_TABLE_NAME} after import"
  set +e
  output="$(aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'ResourceNotFoundException|Requested resource not found'; then
      fail_stop "DynamoDB table ${DATA_TABLE_NAME} does not exist after import."
    fi
    log "ERROR: ${output}"
    fail_stop "dynamodb describe-table failed for ${DATA_TABLE_NAME} after import."
  fi

  TABLE_JSON="$output"
  status="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableStatus) || "");
  ')"
  TABLE_ARN="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableArn) || "");
  ')"

  log "Table exists. TableStatus=${status:-unknown}"
  if [ "${status}" != "ACTIVE" ]; then
    fail_stop "DynamoDB table status is ${status:-missing}, expected ACTIVE."
  fi

  set +e
  caller_json="$(aws sts get-caller-identity --output json 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "ERROR: ${caller_json}"
    fail_stop "sts get-caller-identity failed. Cannot confirm table ARN account/region after import."
  fi

  caller_account="$(CALLER_JSON="$caller_json" node -e '
    const i = JSON.parse(process.env.CALLER_JSON);
    process.stdout.write(i.Account || "");
  ')"
  caller_arn="$(CALLER_JSON="$caller_json" node -e '
    const i = JSON.parse(process.env.CALLER_JSON);
    process.stdout.write(i.Arn || "");
  ')"

  TAGS_JSON='{"Tags":[]}'
  TABLE_TAGS_FAILED=0
  if [ -n "${TABLE_ARN}" ]; then
    set +e
    TAGS_JSON="$(aws dynamodb list-tags-of-resource \
      --region "$AWS_REGION" \
      --resource-arn "$TABLE_ARN" \
      --output json 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      log "ERROR: ${TAGS_JSON}"
      TABLE_TAGS_FAILED=1
      TAGS_JSON='{"Tags":[]}'
    fi
  else
    TABLE_TAGS_FAILED=1
  fi

  ownership_result="$(
    EXPECTED_TABLE_NAME="$DATA_TABLE_NAME" \
    EXPECTED_LOGICAL_ID="$DATA_LOGICAL_ID" \
    EXPECTED_ACCOUNT="$caller_account" \
    EXPECTED_REGION="$AWS_REGION" \
    EXPECTED_SERVICE="$OWNERSHIP_TAG_SERVICE" \
    EXPECTED_STAGE="${OWNERSHIP_TAG_STAGE:-$STAGE}" \
    EXPECTED_PURPOSE="$OWNERSHIP_TAG_PURPOSE" \
    EXPECTED_MANAGED_BY="$OWNERSHIP_TAG_MANAGED_BY" \
    TABLE_JSON="${TABLE_JSON}" \
    TAGS_JSON="${TAGS_JSON}" \
    TAGS_FAILED="${TABLE_TAGS_FAILED}" \
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

const expectedName = process.env.EXPECTED_TABLE_NAME;
const expectedAccount = process.env.EXPECTED_ACCOUNT;
const expectedRegion = process.env.EXPECTED_REGION;
const expectedService = process.env.EXPECTED_SERVICE;
const expectedStage = process.env.EXPECTED_STAGE;
const expectedPurpose = process.env.EXPECTED_PURPOSE;
const expectedManagedBy = process.env.EXPECTED_MANAGED_BY;
const reasons = [];

function parseArn(arn) {
  if (!arn || typeof arn !== 'string') return null;
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return null;
  return {
    service: parts[2],
    region: parts[3],
    account: parts[4],
    resource: parts.slice(5).join(':'),
  };
}

if (table.TableName !== expectedName) {
  reasons.push(`TableName is '${table.TableName || 'missing'}', expected '${expectedName}'`);
}

const parsed = parseArn(table.TableArn || '');
if (!parsed) {
  reasons.push('Table ARN is missing or not a valid DynamoDB ARN');
} else {
  if (parsed.service !== 'dynamodb') {
    reasons.push(`ARN service is '${parsed.service}', expected dynamodb`);
  }
  if (parsed.region !== expectedRegion) {
    reasons.push(`ARN region is '${parsed.region}', expected '${expectedRegion}'`);
  }
  if (!expectedAccount) {
    reasons.push('Caller AWS account could not be determined');
  } else if (parsed.account !== expectedAccount) {
    reasons.push(`ARN account is '${parsed.account}', expected caller account '${expectedAccount}'`);
  }
  const expectedResource = `table/${expectedName}`;
  if (parsed.resource !== expectedResource) {
    reasons.push(`ARN resource is '${parsed.resource}', expected '${expectedResource}'`);
  }
}

if (process.env.TAGS_FAILED === '1') {
  reasons.push('Resource tags could not be listed');
} else {
  const requiredTags = {
    Service: expectedService,
    Stage: expectedStage,
    Purpose: expectedPurpose,
    ManagedBy: expectedManagedBy,
  };
  for (const [key, expected] of Object.entries(requiredTags)) {
    if (!Object.prototype.hasOwnProperty.call(tagMap, key)) {
      reasons.push(`tag ${key} is missing, expected '${expected}'`);
    } else if (tagMap[key] !== expected) {
      reasons.push(`tag ${key} is '${tagMap[key]}', expected '${expected}'`);
    }
  }
}

process.stdout.write(JSON.stringify({
  state: reasons.length === 0 ? 'VERIFIED' : 'UNVERIFIED',
  reasons,
}));
NODE
  )"

  local ownership_state
  ownership_state="$(RESULT_JSON="$ownership_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "UNVERIFIED");
  ')"
  log "Post-import ownership/tag validation: ${ownership_state} (caller ${caller_arn})"

  if [ "${ownership_state}" != "VERIFIED" ]; then
    RESULT_JSON="$ownership_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const reason of r.reasons || []) {
        console.log("[DATA-RECOVERY-EXECUTE] ERROR: " + reason);
      }
    '
    fail_stop "Table ARN/account/region or required Service/Stage/Purpose/ManagedBy tags do not match after import."
  fi
}

echo "======================================="
echo "DATA STACK RECOVERY EXECUTION"
echo "======================================="

SAVED_RECOVERY_STATUS="${RECOVERY_STATUS:-}"
SAVED_DATA_STACK_NAME="${DATA_STACK_NAME:-}"
SAVED_CHANGE_SET_NAME="${CHANGE_SET_NAME:-}"
SAVED_CURRENT_COMMIT="${CURRENT_COMMIT:-}"

if [ -f "$RECOVERY_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RECOVERY_ENV"
  set +a
  log "Consumed ${RECOVERY_ENV}"
else
  log "No recovery env at ${RECOVERY_ENV}. Using process environment."
fi

apply_pipeline_overrides \
  "${SAVED_RECOVERY_STATUS}" \
  "${SAVED_DATA_STACK_NAME}" \
  "${SAVED_CHANGE_SET_NAME}" \
  "${SAVED_CURRENT_COMMIT}"

log "DATA_ACTION=${DATA_ACTION:-}"
log "RECOVERY_STATUS=${RECOVERY_STATUS:-}"
log "stack=${DATA_STACK_NAME:-} changeSet=${CHANGE_SET_NAME:-}"
log "table=${DATA_TABLE_NAME} commit=${CURRENT_COMMIT:-}"

if [ "${DATA_ACTION:-}" != "RECOVERY_REQUIRED" ]; then
  fail_before_execute "DATA_ACTION='${DATA_ACTION:-}' is not RECOVERY_REQUIRED. Refusing to execute the change set."
fi

if ! approval_granted; then
  fail_before_execute "RECOVERY_STATUS='${RECOVERY_STATUS:-}' is not APPROVAL_GRANTED and no equivalent CodePipeline approval marker was supplied."
fi

: "${DATA_STACK_NAME:?DATA_STACK_NAME must be set}"
: "${CHANGE_SET_NAME:?CHANGE_SET_NAME must be set}"
: "${CURRENT_COMMIT:?CURRENT_COMMIT must be set}"
: "${DATA_TABLE_NAME:?DATA_TABLE_NAME must be set}"

if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
  fail_before_execute "CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path."
fi

log "Re-describing change set ${CHANGE_SET_NAME} on ${DATA_STACK_NAME} before execute"
CHANGE_SET_JSON=""
describe_rc=0
set +e
CHANGE_SET_JSON="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --output json 2>&1)"
describe_rc=$?
set -e

if [ "$describe_rc" -ne 0 ]; then
  log "ERROR: ${CHANGE_SET_JSON}"
  fail_before_execute "cloudformation describe-change-set failed for ${CHANGE_SET_NAME}."
fi

validate_change_set "$CHANGE_SET_JSON"
log "Change set re-validated: IMPORT of ${DATA_LOGICAL_ID} (AWS::DynamoDB::Table) only. ExecutionStatus=AVAILABLE."

echo "[DATA-RECOVERY] Executing IMPORT change set"
log "Executing IMPORT change set ${CHANGE_SET_NAME}"
set +e
execute_out="$(aws cloudformation execute-change-set \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" 2>&1)"
execute_rc=$?
set -e
if [ "$execute_rc" -ne 0 ]; then
  log "ERROR: ${execute_out}"
  fail_stop "cloudformation execute-change-set failed for ${CHANGE_SET_NAME}."
fi

log "Waiting for stack import to complete on ${DATA_STACK_NAME}"
set +e
aws cloudformation wait stack-import-complete \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME"
wait_rc=$?
set -e
if [ "$wait_rc" -ne 0 ]; then
  fail_stop "cloudformation wait stack-import-complete failed for ${DATA_STACK_NAME}."
fi

validate_imported_stack
validate_imported_resource
validate_imported_table
write_result_env
echo "[DATA-RECOVERY] IMPORT_COMPLETE"

echo "======================================="
echo "DATA STACK RECOVERY EXECUTION SUMMARY"
echo "======================================="
echo "RECOVERY_STATUS=IMPORT_COMPLETE"
echo "DATA_STACK_STATUS=IMPORT_COMPLETE"
echo "DATA_TABLE_MANAGED=true"
echo "DATA_TABLE_PHYSICAL_ID=${DATA_TABLE_PHYSICAL_ID}"
echo "RECOVERY_COMMIT=${CURRENT_COMMIT}"
echo "SSM parameters: not written (next stage)"
echo "Data UPDATE: not performed (next stage)"
echo "======================================="
echo "DATA STACK RECOVERY EXECUTION COMPLETED"
echo "======================================="
