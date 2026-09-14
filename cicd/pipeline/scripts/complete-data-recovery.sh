#!/bin/bash
# Complete Data stack recovery after a successful DynamoDB table IMPORT.
#
# After execute-data-recovery.sh writes RECOVERY_STATUS=IMPORT_COMPLETE,
# this script performs a normal CloudFormation UPDATE using the immutable
# full Data artifact so the stack contract is restored (DynamoDB table
# logical ID from DATA_LOGICAL_ID, plus any SSM contract resources).
#
# The existing DynamoDB table remains the imported physical resource.
# Never deletes, recreates, or replaces ${DATA_LOGICAL_ID}.
#
# Template source of truth (CURRENT_COMMIT is required):
#   s3://$ARTIFACT_BUCKET/${SERVICE_NAME}/$CURRENT_COMMIT/data/packaged.yaml
# A local packaged.yaml is never used.
#
# Creates an UPDATE change set, machine-validates it, and executes only when
# ${DATA_LOGICAL_ID} is not scheduled for Delete or Replacement.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

assert_stage
assert_codebuild_stage_match

RESULT_ENV="$(resolve_data_recovery_result_env)"
WORKDIR="${DATA_RECOVERY_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/data-recovery-complete.XXXXXX")}"
mkdir -p "$WORKDIR"

DATA_ARTIFACT_URI=""
PACKAGED_TEMPLATE_PATH=""
CHANGE_SET_NAME=""
TABLE_JSON=""
TABLE_ARN=""
TABLE_STREAM_ARN=""
DATA_TABLE_PHYSICAL_ID=""
DATA_STACK_STATUS=""
SSM_TABLE_NAME=""
SSM_TABLE_ARN=""
SSM_STREAM_ARN=""
FAIL_CLOSED="fail_before_execute"

log() {
  echo "[DATA-RECOVERY-COMPLETE] $*"
}

fail_stop() {
  log "ERROR: $*"
  log "ERROR: Recovery completion STOPPED."
  log "ERROR: The DynamoDB table was not deleted or recreated."
  if [ -n "${CHANGE_SET_NAME}" ]; then
    discard_change_set "$CHANGE_SET_NAME"
  fi
  exit 1
}

fail_before_execute() {
  log "ERROR: $*"
  log "ERROR: Recovery completion STOPPED before execute-change-set."
  log "ERROR: The UPDATE change set was not executed."
  log "ERROR: The DynamoDB table was not deleted, recreated, or replaced."
  if [ -n "${CHANGE_SET_NAME}" ]; then
    discard_change_set "$CHANGE_SET_NAME"
  fi
  exit 1
}

cfn_role_args() {
  if [ -n "${CFN_RECOVER_ROLE_ARN:-}" ]; then
    cfn_data_recovery_role_args
    return 0
  fi
  if [ -n "${CFN_DEPLOY_ROLE_ARN:-}" ]; then
    echo "--role-arn"
    echo "$CFN_DEPLOY_ROLE_ARN"
  fi
}

discard_change_set() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    return 0
  fi
  log "Discarding change set ${name}. The table was not modified."
  aws cloudformation delete-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$name" >/dev/null 2>&1 || true
}

write_result_env() {
  local tmp
  mkdir -p "$(dirname "$RESULT_ENV")"
  tmp="${RESULT_ENV}.tmp.$$"
  {
    echo "RECOVERY_STATUS=UPDATE_COMPLETE"
    echo "DATA_STACK_STATUS=UPDATE_COMPLETE"
    echo "DATA_TABLE_MANAGED=true"
    echo "DATA_TABLE_PHYSICAL_ID=${DATA_TABLE_PHYSICAL_ID}"
    echo "RECOVERY_COMMIT=${CURRENT_COMMIT}"
    echo "DATA_ARTIFACT_URI=${DATA_ARTIFACT_URI}"
    echo "TABLE_NAME=${SSM_TABLE_NAME}"
    echo "TABLE_ARN=${SSM_TABLE_ARN}"
    echo "STREAM_ARN=${SSM_STREAM_ARN}"
  } >"$tmp"
  mv "$tmp" "$RESULT_ENV"
  log "Wrote $RESULT_ENV"
}

fetch_immutable_data_artifact() {
  local dest rc=0

  if [ -z "${CURRENT_COMMIT:-}" ]; then
    fail_stop "CURRENT_COMMIT is missing. Post-import UPDATE requires s3://\$ARTIFACT_BUCKET/\${SERVICE_NAME}/\$CURRENT_COMMIT/data/packaged.yaml and must not use a local packaged.yaml."
  fi

  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    fail_stop "CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path."
  fi

  if ! DATA_ARTIFACT_URI="$(immutable_packaged_template_s3_uri data)"; then
    fail_stop "Cannot resolve immutable Data artifact URI for CURRENT_COMMIT=${CURRENT_COMMIT}."
  fi

  dest="$(mktemp "${WORKDIR}/data-packaged.XXXXXX")"
  log "Fetching immutable full Data artifact ${DATA_ARTIFACT_URI}"
  log "CURRENT_COMMIT=${CURRENT_COMMIT}. A local packaged.yaml is ignored."
  set +e
  fetch_immutable_packaged_template data "$dest"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ ! -s "$dest" ]; then
    fail_stop "Immutable S3 Data packaged.yaml is unavailable: ${DATA_ARTIFACT_URI}. Do not fall back to a local packaged.yaml."
  fi
  PACKAGED_TEMPLATE_PATH="$dest"
}

validate_full_data_template() {
  local validation

  if [ -z "${PACKAGED_TEMPLATE_PATH}" ] || [ ! -f "${PACKAGED_TEMPLATE_PATH}" ]; then
    fail_before_execute "Immutable Data artifact was not downloaded. Refusing local packaged.yaml."
  fi

  log "Validating immutable Data template as CloudFormation YAML/JSON."
  log "Template path=${PACKAGED_TEMPLATE_PATH}"

  validation="$(
    TEMPLATE_PATH="${PACKAGED_TEMPLATE_PATH}" \
    EXPECTED_LOGICAL_ID="${DATA_LOGICAL_ID}" \
    node <<'NODE'
const fs = require('fs');
const errors = [];
const raw = fs.readFileSync(process.env.TEMPLATE_PATH, 'utf8');

let template;

/*
 * CloudFormation packaged.yaml is normally YAML. JSON is also valid YAML.
 * Do not use JSON.parse() because that rejects legitimate CloudFormation YAML.
 *
 * js-yaml is expected to be present in the build image/dependencies. If it is
 * unavailable, fail closed rather than skipping template validation.
 */
try {
  const yaml = require('js-yaml');
  template = yaml.load(raw);
} catch (e) {
  process.stdout.write(
    `NO\nUnable to parse immutable Data CloudFormation template as YAML: ${e.message}`
  );
  process.exit(0);
}

if (!template || typeof template !== 'object') {
  process.stdout.write('NO\nImmutable Data CloudFormation template is empty or invalid.');
  process.exit(0);
}

const resources = template.Resources || {};
const logicalId = process.env.EXPECTED_LOGICAL_ID || 'PrimaryTable';
const required = {
  [logicalId]: 'AWS::DynamoDB::Table',
};

for (const [logical, type] of Object.entries(required)) {
  const resource = resources[logical];

  if (!resource) {
    errors.push(`Full Data template is missing ${logical}`);
  } else if (resource.Type !== type) {
    errors.push(
      `${logical} type is '${resource.Type || 'missing'}', expected ${type}`
    );
  }
}

/*
 * These policies are a hard safety requirement for the persistent Data
 * resource. They protect the retained DynamoDB table from accidental
 * deletion/replacement in future normal updates.
 */
const table = resources[logicalId];
if (table) {
  if ((table.DeletionPolicy || '') !== 'Retain') {
    errors.push(
      `${logicalId} DeletionPolicy is '${table.DeletionPolicy || 'missing'}', expected Retain`
    );
  }

  if ((table.UpdateReplacePolicy || '') !== 'Retain') {
    errors.push(
      `${logicalId} UpdateReplacePolicy is '${table.UpdateReplacePolicy || 'missing'}', expected Retain`
    );
  }
}

process.stdout.write(errors.length ? `NO\n${errors.join('\n')}` : 'YES');
NODE
  )"

  if [ "${validation}" != "YES" ]; then
    printf '%s\n' "${validation}" | sed 's/^/[DATA-RECOVERY-COMPLETE] ERROR: /'
    fail_before_execute "Immutable Data artifact failed complete Data contract validation. No UPDATE was executed."
  fi

  log "Immutable artifact contains ${DATA_LOGICAL_ID} with Retain policies."
  log "${DATA_LOGICAL_ID} retention policies validated: DeletionPolicy=Retain, UpdateReplacePolicy=Retain."
}

validate_imported_stack() {
  local output rc=0

  log "Confirming CloudFormation stack ${DATA_STACK_NAME} is IMPORT_COMPLETE before UPDATE"
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qi 'does not exist'; then
      fail_before_execute "CloudFormation stack ${DATA_STACK_NAME} does not exist. Post-import UPDATE requires IMPORT_COMPLETE."
    fi
    log "ERROR: ${output}"
    fail_before_execute "CloudFormation describe-stacks failed for ${DATA_STACK_NAME}."
  fi

  DATA_STACK_STATUS="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ -z "${DATA_STACK_STATUS}" ] || [ "${DATA_STACK_STATUS}" = "None" ] || [ "${DATA_STACK_STATUS}" = "DELETE_COMPLETE" ]; then
    fail_before_execute "CloudFormation stack ${DATA_STACK_NAME} does not exist (status=${DATA_STACK_STATUS:-missing})."
  fi

  if [ "${DATA_STACK_STATUS}" != "IMPORT_COMPLETE" ]; then
    fail_before_execute "Stack status is ${DATA_STACK_STATUS}, expected IMPORT_COMPLETE before the normal Data UPDATE."
  fi
  log "Stack exists. StackStatus=${DATA_STACK_STATUS}"
}

validate_managed_workflow_table() {
  local output rc=0
  local resource_type logical_id

  log "Confirming CloudFormation manages logical resource ${DATA_LOGICAL_ID}"
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
      fail_before_execute "${DATA_LOGICAL_ID} is not CloudFormation-managed on ${DATA_STACK_NAME}."
    fi
    log "ERROR: ${output}"
    fail_before_execute "cloudformation describe-stack-resource failed for ${DATA_LOGICAL_ID}."
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
    fail_before_execute "Logical resource ID is '${logical_id:-missing}', expected ${DATA_LOGICAL_ID}."
  fi
  if [ "${resource_type}" != "AWS::DynamoDB::Table" ]; then
    fail_before_execute "ResourceType is '${resource_type:-missing}', expected AWS::DynamoDB::Table."
  fi
  if [ -z "${DATA_TABLE_PHYSICAL_ID}" ] || [ "${DATA_TABLE_PHYSICAL_ID}" != "${DATA_TABLE_NAME}" ]; then
    fail_before_execute "PhysicalResourceId is '${DATA_TABLE_PHYSICAL_ID:-missing}', expected table ${DATA_TABLE_NAME}."
  fi
  log "${DATA_LOGICAL_ID} is CloudFormation-managed. PhysicalResourceId=${DATA_TABLE_PHYSICAL_ID}"
}

validate_live_table_active() {
  local output rc=0 status

  log "Confirming DynamoDB table ${DATA_TABLE_NAME} is ACTIVE"
  set +e
  output="$(aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'ResourceNotFoundException|Requested resource not found'; then
      "${FAIL_CLOSED}" "DynamoDB table ${DATA_TABLE_NAME} does not exist. The table will not be created."
    fi
    log "ERROR: ${output}"
    "${FAIL_CLOSED}" "dynamodb describe-table failed for ${DATA_TABLE_NAME}."
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
  TABLE_STREAM_ARN="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).LatestStreamArn) || "");
  ')"

  log "Table exists. TableStatus=${status:-unknown}"
  if [ "${status}" != "ACTIVE" ]; then
    "${FAIL_CLOSED}" "DynamoDB table status is ${status:-missing}, expected ACTIVE."
  fi
  if [ -z "${TABLE_ARN}" ]; then
    "${FAIL_CLOSED}" "DynamoDB table ARN is missing."
  fi
  if [ -z "${TABLE_STREAM_ARN}" ]; then
    "${FAIL_CLOSED}" "DynamoDB table stream ARN is missing. STREAM_ARN cannot be restored."
  fi
}

validate_update_change_set() {
  local change_set_json="$1"
  local validation

  validation="$(
    CHANGE_SET_JSON="$change_set_json" \
    EXPECTED_TABLE="${DATA_TABLE_NAME}" \
    EXPECTED_LOGICAL_ID="${DATA_LOGICAL_ID}" \
    node <<'NODE'
const cs = JSON.parse(process.env.CHANGE_SET_JSON || '{}');
const errors = [];
const changes = Array.isArray(cs.Changes) ? cs.Changes : [];
const resourceChanges = changes.filter((c) => c && (c.Type === 'Resource' || c.ResourceChange));

if (cs.ExecutionStatus && cs.ExecutionStatus !== 'AVAILABLE') {
  errors.push(`ExecutionStatus is '${cs.ExecutionStatus}', expected AVAILABLE`);
}
if (cs.Status && cs.Status !== 'CREATE_COMPLETE') {
  errors.push(`Change set status is '${cs.Status}', expected CREATE_COMPLETE`);
  if (cs.StatusReason) {
    errors.push(`StatusReason: ${cs.StatusReason}`);
  }
}

for (const change of resourceChanges) {
  const rc = change.ResourceChange || {};
  const action = rc.Action || '';
  const logical = rc.LogicalResourceId || '';
  const type = rc.ResourceType || '';
  const replacement = rc.Replacement || 'False';
  const isTable = logical === process.env.EXPECTED_LOGICAL_ID || type === 'AWS::DynamoDB::Table';

  if (isTable && (action === 'Remove' || action === 'Delete')) {
    errors.push(`STOP: ${process.env.EXPECTED_LOGICAL_ID} is scheduled for Delete (Action=${action})`);
  }
  if (isTable && (replacement === 'True' || replacement === 'Conditional')) {
    errors.push(`STOP: ${process.env.EXPECTED_LOGICAL_ID} is scheduled for Replacement (Replacement=${replacement})`);
  }
  if (isTable && (action === 'Add' || action === 'Create')) {
    errors.push(`STOP: Change set would CREATE DynamoDB table ${logical || 'unknown'}`);
  }
  if (isTable && type && type !== 'AWS::DynamoDB::Table') {
    errors.push(`${process.env.EXPECTED_LOGICAL_ID} ResourceType is '${type}', expected AWS::DynamoDB::Table`);
  }
  if (isTable && rc.PhysicalResourceId && rc.PhysicalResourceId !== process.env.EXPECTED_TABLE) {
    errors.push(`${process.env.EXPECTED_LOGICAL_ID} PhysicalResourceId is '${rc.PhysicalResourceId}', expected '${process.env.EXPECTED_TABLE}'`);
  }
}

process.stdout.write(errors.length ? `NO\n${errors.join('\n')}` : 'YES');
NODE
  )"

  if [ "${validation}" != "YES" ]; then
    printf '%s\n' "${validation}" | sed 's/^/[DATA-RECOVERY-COMPLETE] ERROR: /'
    if printf '%s' "${validation}" | grep -q "STOP: ${DATA_LOGICAL_ID} is scheduled for"; then
      fail_before_execute "${DATA_LOGICAL_ID} is scheduled for Delete or Replacement. STOP immediately. The change set was not executed."
    fi
    fail_before_execute "UPDATE change set failed machine validation. execute-change-set was not called."
  fi
}

validate_updated_stack() {
  local output rc=0

  log "Validating CloudFormation stack ${DATA_STACK_NAME} after UPDATE"
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    log "ERROR: ${output}"
    fail_stop "CloudFormation describe-stacks failed for ${DATA_STACK_NAME} after UPDATE."
  fi

  DATA_STACK_STATUS="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ "${DATA_STACK_STATUS}" != "UPDATE_COMPLETE" ]; then
    fail_stop "Stack status is ${DATA_STACK_STATUS}, expected UPDATE_COMPLETE."
  fi
  log "Stack status is UPDATE_COMPLETE"
}

validate_updated_resource() {
  local output rc=0
  local resource_type physical_id logical_id

  log "Validating logical resource ${DATA_LOGICAL_ID} after UPDATE"
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
      fail_stop "${DATA_LOGICAL_ID} is no longer CloudFormation-managed after UPDATE."
    fi
    log "ERROR: ${output}"
    fail_stop "cloudformation describe-stack-resource failed for ${DATA_LOGICAL_ID} after UPDATE."
  fi

  resource_type="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).ResourceType) || "");
  ')"
  logical_id="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).LogicalResourceId) || "");
  ')"
  physical_id="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).PhysicalResourceId) || "");
  ')"

  if [ "${logical_id}" != "${DATA_LOGICAL_ID}" ]; then
    fail_stop "Logical resource ID is '${logical_id:-missing}', expected ${DATA_LOGICAL_ID}."
  fi
  if [ "${resource_type}" != "AWS::DynamoDB::Table" ]; then
    fail_stop "ResourceType is '${resource_type:-missing}', expected AWS::DynamoDB::Table."
  fi
  if [ -z "${physical_id}" ] || [ "${physical_id}" != "${DATA_TABLE_NAME}" ]; then
    fail_stop "Physical table changed. PhysicalResourceId is '${physical_id:-missing}', expected ${DATA_TABLE_NAME}."
  fi
  if [ "${physical_id}" != "${DATA_TABLE_PHYSICAL_ID}" ]; then
    fail_stop "Physical table changed from ${DATA_TABLE_PHYSICAL_ID} to ${physical_id}."
  fi
  DATA_TABLE_PHYSICAL_ID="$physical_id"
  log "${DATA_LOGICAL_ID} is still managed. PhysicalResourceId=${DATA_TABLE_PHYSICAL_ID} (unchanged)"
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
    fail_stop "Required SSM parameter ${name} is missing or empty after UPDATE."
  fi
  printf '%s' "$output"
}

validate_ssm_contract() {
  local expected_name expected_arn expected_stream

  expected_name="${DATA_TABLE_NAME}"
  expected_arn="${TABLE_ARN}"
  expected_stream="${TABLE_STREAM_ARN}"

  log "Validating Data SSM contract under ${SSM_PREFIX}"
  SSM_TABLE_NAME="$(read_ssm_parameter "${SSM_PREFIX}/TABLE_NAME")"
  SSM_TABLE_ARN="$(read_ssm_parameter "${SSM_PREFIX}/TABLE_ARN")"
  SSM_STREAM_ARN="$(read_ssm_parameter "${SSM_PREFIX}/STREAM_ARN")"

  log "TABLE_NAME=${SSM_TABLE_NAME}"
  log "TABLE_ARN=${SSM_TABLE_ARN}"
  log "STREAM_ARN=${SSM_STREAM_ARN}"

  if [ "${SSM_TABLE_NAME}" != "${expected_name}" ]; then
    fail_stop "SSM TABLE_NAME is '${SSM_TABLE_NAME}', expected '${expected_name}'."
  fi
  if [ "${SSM_TABLE_ARN}" != "${expected_arn}" ]; then
    fail_stop "SSM TABLE_ARN is '${SSM_TABLE_ARN}', expected '${expected_arn}'."
  fi
  if [ "${SSM_STREAM_ARN}" != "${expected_stream}" ]; then
    fail_stop "SSM STREAM_ARN is '${SSM_STREAM_ARN}', expected '${expected_stream}'."
  fi
  log "All three SSM parameters exist and match the imported table."
}

echo "======================================="
echo "DATA STACK RECOVERY COMPLETION"
echo "======================================="

SAVED_CURRENT_COMMIT="${CURRENT_COMMIT:-}"
SAVED_DATA_STACK_NAME="${DATA_STACK_NAME:-}"
SAVED_RECOVERY_STATUS="${RECOVERY_STATUS:-}"

if [ -f "$RESULT_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RESULT_ENV"
  set +a
  log "Consumed ${RESULT_ENV}"
else
  log "No recovery result env at ${RESULT_ENV}. Using process environment."
fi

if [ -n "${SAVED_CURRENT_COMMIT}" ]; then
  if [ -n "${CURRENT_COMMIT:-}" ] && [ "${SAVED_CURRENT_COMMIT}" != "${CURRENT_COMMIT}" ]; then
    fail_before_execute "CURRENT_COMMIT from the environment (${SAVED_CURRENT_COMMIT}) does not match the recovery result (${CURRENT_COMMIT})."
  fi
  CURRENT_COMMIT="${SAVED_CURRENT_COMMIT}"
fi
if [ -n "${SAVED_DATA_STACK_NAME}" ]; then
  if [ -n "${DATA_STACK_NAME:-}" ] && [ "${SAVED_DATA_STACK_NAME}" != "${DATA_STACK_NAME}" ]; then
    fail_before_execute "DATA_STACK_NAME from the environment (${SAVED_DATA_STACK_NAME}) does not match the recovery result (${DATA_STACK_NAME})."
  fi
  DATA_STACK_NAME="${SAVED_DATA_STACK_NAME}"
fi
if [ "${SAVED_RECOVERY_STATUS}" = "IMPORT_COMPLETE" ]; then
  RECOVERY_STATUS="IMPORT_COMPLETE"
fi

: "${DATA_STACK_NAME:?DATA_STACK_NAME must be set}"
: "${DATA_TABLE_NAME:?DATA_TABLE_NAME must be set}"
: "${CURRENT_COMMIT:?CURRENT_COMMIT must be set}"

log "RECOVERY_STATUS=${RECOVERY_STATUS:-}"
log "stack=${DATA_STACK_NAME} table=${DATA_TABLE_NAME}"
log "commit=${CURRENT_COMMIT}"

if [ "${RECOVERY_STATUS:-}" != "IMPORT_COMPLETE" ]; then
  fail_before_execute "RECOVERY_STATUS='${RECOVERY_STATUS:-}' is not IMPORT_COMPLETE. Post-import UPDATE will not run."
fi

fetch_immutable_data_artifact
validate_full_data_template
validate_imported_stack
validate_managed_workflow_table
validate_live_table_active

log "======================================="
log "POST-IMPORT VALIDATION PASSED"
log "======================================="
log "${DATA_LOGICAL_ID} is CloudFormation-managed."
log "${DATA_LOGICAL_ID} physical ID=${DATA_TABLE_PHYSICAL_ID}"
log "DynamoDB table is ACTIVE."
log "Immutable Data artifact is validated."
log "CloudFormation stack is IMPORT_COMPLETE."
log "Starting normal Data stack UPDATE to restore deployment-contract resources."
log "======================================="

echo "[DATA-RECOVERY] Starting normal Data stack UPDATE to restore deployment-contract resources"
echo "[DATA-RECOVERY] Using immutable Data artifact:"
echo "[DATA-RECOVERY] ${DATA_ARTIFACT_URI}"

CHANGE_SET_NAME="recoveryDataUpdate-$(date +%s)"
log "Creating normal CloudFormation UPDATE change set ${CHANGE_SET_NAME}"
log "template-body=file://${PACKAGED_TEMPLATE_PATH}"
log "artifact=${DATA_ARTIFACT_URI}"

create_out=""
create_rc=0
set +e
# shellcheck disable=SC2046
create_out="$(aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --change-set-type UPDATE \
  --template-body "file://${PACKAGED_TEMPLATE_PATH}" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --output json \
  $(cfn_role_args) \
  --tags \
    "Key=Service,Value=${SERVICE_NAME}" \
    "Key=Stage,Value=${STAGE}" \
    "Key=ManagedBy,Value=serverless" \
    "Key=Stack,Value=data" 2>&1)"
create_rc=$?
set -e

if [ "$create_rc" -ne 0 ]; then
  log "ERROR: ${create_out}"
  fail_before_execute "cloudformation create-change-set failed for the normal Data UPDATE."
fi

log "Waiting for UPDATE change set ${CHANGE_SET_NAME} to reach CREATE_COMPLETE."
set +e
aws cloudformation wait change-set-create-complete \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME"
wait_change_set_rc=$?
set -e

if [ "$wait_change_set_rc" -ne 0 ]; then
  log "ERROR: CloudFormation change-set waiter failed."
  log "Fetching change-set diagnostics..."

  aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME" \
    --query '[Status,StatusReason,ExecutionStatus,Changes]' \
    --output json || true

  fail_before_execute "UPDATE change-set did not reach CREATE_COMPLETE."
fi

log "UPDATE change set reached CREATE_COMPLETE."

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

validate_update_change_set "$CHANGE_SET_JSON"
log "UPDATE change set validated: ${DATA_LOGICAL_ID} is not scheduled for Delete or Replacement."

log "Executing UPDATE change set ${CHANGE_SET_NAME}"
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

log "Waiting for stack UPDATE_COMPLETE on ${DATA_STACK_NAME}"
set +e
aws cloudformation wait stack-update-complete \
  --region "$AWS_REGION" \
  --stack-name "$DATA_STACK_NAME"
wait_rc=$?
set -e
if [ "$wait_rc" -ne 0 ]; then
  log "ERROR: CloudFormation UPDATE waiter failed."
  log "Fetching recent CloudFormation stack events for diagnosis..."

  aws cloudformation describe-stack-events     --region "$AWS_REGION"     --stack-name "$DATA_STACK_NAME"     --query 'StackEvents[0:15].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]'     --output table || true

  fail_stop "cloudformation wait stack-update-complete failed for ${DATA_STACK_NAME}."
fi

log "CloudFormation UPDATE waiter completed successfully."

FAIL_CLOSED="fail_stop"
validate_updated_stack
validate_updated_resource
validate_live_table_active
validate_ssm_contract
write_result_env
echo "[DATA-RECOVERY] Data stack UPDATE_COMPLETE"
echo "[DATA-RECOVERY] Data SSM contract restored"

echo "======================================="
echo "DATA STACK RECOVERY COMPLETION SUMMARY"
echo "======================================="
echo "RECOVERY_STATUS=UPDATE_COMPLETE"
echo "DATA_STACK_STATUS=UPDATE_COMPLETE"
echo "DATA_TABLE_MANAGED=true"
echo "DATA_TABLE_PHYSICAL_ID=${DATA_TABLE_PHYSICAL_ID}"
echo "RECOVERY_COMMIT=${CURRENT_COMMIT}"
echo "DATA_ARTIFACT_URI=${DATA_ARTIFACT_URI}"
echo "TABLE_NAME=${SSM_TABLE_NAME}"
echo "TABLE_ARN=${SSM_TABLE_ARN}"
echo "STREAM_ARN=${SSM_STREAM_ARN}"
echo "======================================="
echo "DATA STACK RECOVERY COMPLETION COMPLETED"
echo "======================================="
