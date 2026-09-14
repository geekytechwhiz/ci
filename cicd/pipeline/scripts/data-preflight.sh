#!/bin/bash
# Data stack preflight for ${STAGE}-${SERVICE_NAME}-data.
#
# Read-only classifier. Does not create, update, delete, import, or roll back
# any CloudFormation or DynamoDB resource. Used by Deploy-Data before
# CloudFormation so a retained table cannot be targeted by CREATE.
#
# This is the primary classification. deploy-data.sh consumes the generated
# deployment-data-preflight.env and must not run this classifier again.
#
# DATA_ACTION:
#   UPDATE              Data stack exists, is usable, and CloudFormation still
#                       manages the expected DynamoDB table physical resource
#   CREATE              Data stack missing and the expected table is missing
#   RECOVERY_REQUIRED   Data stack missing, expected table exists, all ownership
#                       tags verified, configuration compatible (import is NOT run)
#   STOP                Unsafe stack state, resource not managed, unverified
#                       ownership, missing artifact, or incompatible configuration
#
# Pipeline artifact source of truth (when CURRENT_COMMIT is set):
#   s3://$ARTIFACT_BUCKET/${SERVICE_NAME}/$CURRENT_COMMIT/data/packaged.yaml
# A local packaged.yaml is used only when CURRENT_COMMIT is unset
# (manual / emergency / tests). The pipeline must never fall back to local.
#
# Writes deployment-data-preflight.env (override with
# DATA_PREFLIGHT_ENV). Always exits 0 after a successful classification so
# CodeBuild can keep the env file; deploy-data.sh enforces STOP / RECOVERY.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"

assert_stage
assert_codebuild_stage_match

PREFLIGHT_ENV="$(resolve_data_preflight_env)"
mkdir -p "$(dirname "$PREFLIGHT_ENV")"


DATA_STACK_STATE="UNKNOWN"
DATA_STACK_STATUS=""
DATA_TABLE_STATE="NOT_CHECKED"
DATA_TABLE_STATUS=""
DATA_TABLE_OWNERSHIP="NOT_APPLICABLE"
DATA_TABLE_CONFIGURATION="NOT_APPLICABLE"
DATA_ACTION=""
DATA_STOP_REASON=""
DATA_ARTIFACT_COMMIT=""
DATA_ARTIFACT_URI=""
PACKAGED_TEMPLATE_PATH=""

log() {
  echo "[DATA-PREFLIGHT] $*"
}

write_preflight_env() {
  local tmp
  tmp="${PREFLIGHT_ENV}.tmp.$$"
  {
    echo "DATA_STACK_STATE=${DATA_STACK_STATE}"
    if [ -n "${DATA_STACK_STATUS}" ]; then
      echo "DATA_STACK_STATUS=${DATA_STACK_STATUS}"
    fi
    echo "DATA_TABLE_STATE=${DATA_TABLE_STATE}"
    if [ -n "${DATA_TABLE_STATUS}" ]; then
      echo "DATA_TABLE_STATUS=${DATA_TABLE_STATUS}"
    fi
    echo "DATA_TABLE_OWNERSHIP=${DATA_TABLE_OWNERSHIP}"
    echo "DATA_TABLE_CONFIGURATION=${DATA_TABLE_CONFIGURATION}"
    echo "DATA_ACTION=${DATA_ACTION}"
    if [ -n "${DATA_STOP_REASON}" ]; then
      echo "DATA_STOP_REASON=${DATA_STOP_REASON}"
    fi
    echo "DATA_ARTIFACT_COMMIT=${DATA_ARTIFACT_COMMIT}"
    echo "DATA_ARTIFACT_URI=${DATA_ARTIFACT_URI}"
  } >"$tmp"
  mv "$tmp" "$PREFLIGHT_ENV"
  log "Wrote $PREFLIGHT_ENV"
}

finish() {
  write_preflight_env
  log "Final action: ${DATA_ACTION}"
  if [ -n "${DATA_STOP_REASON}" ]; then
    log "Stop reason: ${DATA_STOP_REASON}"
  fi
  log "Artifact commit: ${DATA_ARTIFACT_COMMIT:-<none>}"
  log "Artifact URI: ${DATA_ARTIFACT_URI:-<none>}"
  case "${DATA_ACTION}" in
    UPDATE)
      log "Data stack is usable and CloudFormation manages the expected DynamoDB table."
      log "Deploy-Data may perform a CloudFormation update of the validated artifact."
      ;;
    CREATE)
      log "No Data stack and no expected table. Deploy-Data may perform a CloudFormation create."
      ;;
    RECOVERY_REQUIRED)
      log "Data stack is missing but the expected DynamoDB table still exists."
      log "Normal CREATE is blocked. Do not delete, recreate, or import the table in this stage."
      log "Deploy-Data will prepare an IMPORT-only change set for ${DATA_LOGICAL_ID} and wait for manual approval."
      ;;
    STOP)
      log "Deployment is being stopped. CloudFormation CREATE/UPDATE will not run."
      log "Infra and App stages must not continue."
      ;;
    *)
      log "ERROR: internal classifier produced an unknown action: ${DATA_ACTION:-<empty>}"
      exit 1
      ;;
  esac
}

aws_json() {
  aws "$@" --output json
}

stack_is_usable() {
  case "$1" in
    CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

stack_is_in_progress() {
  case "$1" in
    *_IN_PROGRESS|REVIEW_IN_PROGRESS)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resource_is_healthy() {
  stack_is_usable "$1"
}

# Resolve the Data packaged template used for configuration comparison.
# Pipeline (CURRENT_COMMIT set): immutable S3 artifact only. No local fallback.
# Manual/emergency/tests (CURRENT_COMMIT unset): local packaged.yaml only.
resolve_packaged_data_template() {
  local dest rc=0

  if [ -n "${CURRENT_COMMIT:-}" ]; then
    DATA_ARTIFACT_COMMIT="${CURRENT_COMMIT}"
    if [ -z "${ARTIFACT_BUCKET:-}" ]; then
      DATA_ARTIFACT_URI=""
      log "ERROR: CURRENT_COMMIT is set but ARTIFACT_BUCKET is missing."
      log "ERROR: Cannot locate s3://<artifact-bucket>/${SERVICE_NAME}/${CURRENT_COMMIT}/data/packaged.yaml"
      return 1
    fi
    if ! DATA_ARTIFACT_URI="$(immutable_packaged_template_s3_uri data)"; then
      DATA_ARTIFACT_URI=""
      return 1
    fi
    dest="$(mktemp "${TMPDIR:-/tmp}/data-packaged.XXXXXX.yaml")"
    log "Validating against immutable Data artifact ${DATA_ARTIFACT_URI}"
    log "CURRENT_COMMIT=${CURRENT_COMMIT}. A local packaged.yaml is ignored."
    set +e
    fetch_immutable_packaged_template data "$dest"
    rc=$?
    set -e
    if [ "$rc" -ne 0 ] || [ ! -s "$dest" ]; then
      log "ERROR: Immutable Data artifact is unavailable: ${DATA_ARTIFACT_URI}"
      log "ERROR: Do not fall back to a local packaged.yaml when CURRENT_COMMIT is set."
      rm -f "$dest"
      return 1
    fi
    PACKAGED_TEMPLATE_PATH="$dest"
    return 0
  fi

  dest="${DATA_PACKAGED_TEMPLATE:-$SERVICE_DIR/data/packaged.yaml}"
  DATA_ARTIFACT_COMMIT=""
  DATA_ARTIFACT_URI="file://${dest}"
  log "CURRENT_COMMIT is unset. Using local Data template ${dest}"
  log "This local-template path is for manual, emergency, or test use only."
  log "Pipeline Deploy-Data must set CURRENT_COMMIT and use the immutable S3 artifact."
  if [ -f "$dest" ]; then
    PACKAGED_TEMPLATE_PATH="$dest"
  else
    PACKAGED_TEMPLATE_PATH=""
    log "Local Data template was not found at ${dest}."
  fi
  return 0
}

describe_data_stack() {
  local output rc=0
  log "Checking CloudFormation stack"
  log "Stack name: ${DATA_STACK_NAME}"
  log "Region: ${AWS_REGION}"

  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qi 'does not exist'; then
      DATA_STACK_STATE="NOT_FOUND"
      DATA_STACK_STATUS=""
      log "Stack status: NOT_FOUND"
      return 0
    fi
    DATA_STACK_STATE="UNKNOWN"
    DATA_ACTION="STOP"
    DATA_STOP_REASON="CLOUDFORMATION_API_ERROR"
    log "Stack status: UNKNOWN"
    log "ERROR: CloudFormation describe-stacks failed for ${DATA_STACK_NAME}."
    log "ERROR: ${output}"
    log "ERROR: Deployment is stopped because stack state cannot be classified safely."
    return 1
  fi

  DATA_STACK_STATUS="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ -z "${DATA_STACK_STATUS}" ] || [ "${DATA_STACK_STATUS}" = "None" ]; then
    DATA_STACK_STATE="NOT_FOUND"
    DATA_STACK_STATUS=""
    log "Stack status: NOT_FOUND"
    return 0
  fi

  if [ "${DATA_STACK_STATUS}" = "DELETE_COMPLETE" ]; then
    DATA_STACK_STATE="NOT_FOUND"
    DATA_STACK_STATUS=""
    log "Stack status: NOT_FOUND (DELETE_COMPLETE)"
    return 0
  fi

  DATA_STACK_STATE="EXISTS"
  log "Stack status: ${DATA_STACK_STATUS}"
  return 0
}

# True when AWS reports that the DynamoDB table does not exist.
# Matches CLI legacy text and JSON error bodies without grep -q (SIGPIPE under pipefail).
dynamodb_error_is_not_found() {
  local output_lc
  output_lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${output_lc}" in
    *resourcenotfoundexception*|*tablenotfoundexception*|*"requested resource not found"*)
      return 0
      ;;
  esac
  return 1
}

describe_workflow_table() {
  local output rc=0
  log "Checking DynamoDB resource"
  log "Expected table: ${DATA_TABLE_NAME}"
  log "Expected account/region/service/environment come from the live caller identity and STAGE=${STAGE}"

  set +e
  output="$(aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if dynamodb_error_is_not_found "$output"; then
      DATA_TABLE_STATE="NOT_FOUND"
      DATA_TABLE_STATUS=""
      TABLE_JSON=""
      TABLE_ARN=""
      log "Resource exists: no"
      return 0
    fi
    DATA_TABLE_STATE="UNKNOWN"
    DATA_ACTION="STOP"
    DATA_STOP_REASON="DYNAMODB_API_ERROR"
    log "Resource exists: unknown"
    log "ERROR: dynamodb describe-table failed for ${DATA_TABLE_NAME}."
    log "ERROR: ${output}"
    log "ERROR: Deployment is stopped because table state cannot be classified safely."
    return 1
  fi

  DATA_TABLE_STATE="EXISTS"
  TABLE_JSON="$output"
  DATA_TABLE_STATUS="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableStatus) || "");
  ')"
  TABLE_ARN="$(TABLE_JSON="$output" node -e '
    const t = JSON.parse(process.env.TABLE_JSON);
    process.stdout.write(((t.Table || {}).TableArn) || "");
  ')"
  log "Resource exists: yes"
  log "Table status: ${DATA_TABLE_STATUS:-unknown}"
  return 0
}

# When the Data stack exists, UPDATE is allowed only if CloudFormation still
# manages logical ID ${DATA_LOGICAL_ID} and the physical resource is the expected table.
validate_managed_workflow_table() {
  local output rc=0
  local resource_type resource_status physical_id logical_id

  log "Verifying CloudFormation still manages logical resource ${DATA_LOGICAL_ID}"

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
      DATA_ACTION="STOP"
      DATA_STOP_REASON="RESOURCE_NOT_MANAGED"
      log "ERROR: CloudFormation does not manage logical resource ${DATA_LOGICAL_ID} on ${DATA_STACK_NAME}."
      log "ERROR: ${output}"
      log "ERROR: A matching stack name is not enough. Deployment is stopped. No recreate or import."
      return 1
    fi
    DATA_ACTION="STOP"
    DATA_STOP_REASON="CLOUDFORMATION_API_ERROR"
    log "ERROR: cloudformation describe-stack-resource failed for ${DATA_LOGICAL_ID}."
    log "ERROR: ${output}"
    log "ERROR: Deployment is stopped because the managed resource cannot be classified safely."
    return 1
  fi

  resource_type="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).ResourceType) || "");
  ')"
  resource_status="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).ResourceStatus) || "");
  ')"
  physical_id="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).PhysicalResourceId) || "");
  ')"
  logical_id="$(STACK_RESOURCE_JSON="$output" node -e '
    const d = JSON.parse(process.env.STACK_RESOURCE_JSON);
    process.stdout.write(((d.StackResourceDetail || {}).LogicalResourceId) || "");
  ')"

  log "Logical ID: ${logical_id:-missing}"
  log "Resource type: ${resource_type:-missing}"
  log "Resource status: ${resource_status:-missing}"
  log "Physical resource ID: ${physical_id:-missing}"

  if [ "${logical_id}" != "${DATA_LOGICAL_ID}" ]; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="RESOURCE_NOT_MANAGED"
    log "ERROR: Logical resource ID is '${logical_id:-missing}', expected ${DATA_LOGICAL_ID}."
    return 1
  fi

  if [ "${resource_type}" != "AWS::DynamoDB::Table" ]; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="RESOURCE_IDENTITY_MISMATCH"
    log "ERROR: ResourceType is '${resource_type:-missing}', expected AWS::DynamoDB::Table."
    log "ERROR: CloudFormation is not managing the expected DynamoDB table. No recreate or import."
    return 1
  fi

  if ! resource_is_healthy "${resource_status}"; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="RESOURCE_UNHEALTHY"
    log "ERROR: ${DATA_LOGICAL_ID} ResourceStatus is ${resource_status:-missing}, which is not healthy."
    log "ERROR: Deployment is stopped. ContinueUpdateRollback is not executed automatically."
    return 1
  fi

  if [ -z "${physical_id}" ] || [ "${physical_id}" != "${DATA_TABLE_NAME}" ]; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="RESOURCE_IDENTITY_MISMATCH"
    log "ERROR: PhysicalResourceId is '${physical_id:-missing}', expected table ${DATA_TABLE_NAME}."
    log "ERROR: Logical ${DATA_LOGICAL_ID} points at an unexpected physical resource. No recreate or import."
    return 1
  fi

  if ! describe_workflow_table; then
    return 1
  fi

  if [ "${DATA_TABLE_STATE}" = "NOT_FOUND" ]; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="RESOURCE_MISSING"
    log "ERROR: CloudFormation lists ${DATA_TABLE_NAME} as ${DATA_LOGICAL_ID}, but the DynamoDB table does not exist."
    log "ERROR: Deployment is stopped. The table will not be created or imported automatically."
    return 1
  fi

  if [ "${DATA_TABLE_STATE}" != "EXISTS" ]; then
    DATA_ACTION="STOP"
    DATA_STOP_REASON="${DATA_STOP_REASON:-DYNAMODB_API_ERROR}"
    return 1
  fi

  return 0
}

validate_table_ownership() {
  local caller_json caller_arn tags_json tags_rc=0
  local ownership_result
  local caller_account

  DATA_TABLE_OWNERSHIP="UNVERIFIED"

  set +e
  caller_json="$(aws sts get-caller-identity --output json 2>&1)"
  tags_rc=$?
  set -e
  if [ "$tags_rc" -ne 0 ]; then
    log "Ownership validation: UNVERIFIED"
    log "ERROR: sts get-caller-identity failed. Cannot confirm AWS account ownership."
    log "ERROR: ${caller_json}"
    DATA_STOP_REASON="OWNERSHIP_UNVERIFIED"
    return 0
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
    tags_rc=$?
    set -e
    if [ "$tags_rc" -ne 0 ]; then
      log "Ownership validation: UNVERIFIED"
      log "ERROR: dynamodb list-tags-of-resource failed for ${TABLE_ARN}."
      log "ERROR: ${tags_json}"
      log "ERROR: A matching table name is not enough to claim this resource."
      DATA_STOP_REASON="OWNERSHIP_UNVERIFIED"
      tags_json='{"Tags":[]}'
      TABLE_TAGS_FAILED=1
    fi
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
    TABLE_JSON="${TABLE_JSON}" \
    TAGS_JSON="${tags_json}" \
    TAGS_FAILED="${TABLE_TAGS_FAILED:-0}" \
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
  const resource = parts.slice(5).join(':');
  return {
    partition: parts[1],
    service: parts[2],
    region: parts[3],
    account: parts[4],
    resource,
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
  if (reasons.some((r) => r.startsWith('tag '))) {
    reasons.push('identity tags Service, Stage, Purpose, and ManagedBy must all match; a matching table name is not sufficient');
  }
}

const verified = reasons.length === 0;
const result = {
  state: verified ? 'VERIFIED' : 'UNVERIFIED',
  resourceState: verified ? 'RESOURCE_EXISTS_AND_EXPECTED' : 'RESOURCE_EXISTS_BUT_OWNERSHIP_UNVERIFIED',
  reasons,
  callerAccount: expectedAccount || '',
  callerArn: process.env.CALLER_ARN || '',
  tableArn: table.TableArn || '',
};
process.stdout.write(JSON.stringify(result));
NODE
  )"

  DATA_TABLE_OWNERSHIP="$(RESULT_JSON="$ownership_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "UNVERIFIED");
  ')"

  log "Ownership validation: ${DATA_TABLE_OWNERSHIP}"
  log "Caller identity used for account check: ${caller_arn}"
  if [ "${DATA_TABLE_OWNERSHIP}" != "VERIFIED" ]; then
    DATA_STOP_REASON="OWNERSHIP_UNVERIFIED"
    log "ERROR: Ownership could not be confidently verified for ${DATA_TABLE_NAME}."
    RESULT_JSON="$ownership_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const reason of r.reasons || []) {
        console.log("[DATA-PREFLIGHT] ERROR: " + reason);
      }
    '
    log "ERROR: Deployment is stopped. The table will not be deleted, recreated, or imported."
  fi
}

validate_table_configuration() {
  local backups_json backups_rc=0 config_result
  local template_path="${PACKAGED_TEMPLATE_PATH}"

  DATA_TABLE_CONFIGURATION="INCOMPATIBLE"

  if [ -z "${template_path}" ] || [ ! -f "${template_path}" ]; then
    log "Configuration validation: INCOMPATIBLE"
    log "ERROR: Data packaged template was not found. Cannot compare live table configuration."
    if [ -n "${CURRENT_COMMIT:-}" ]; then
      log "ERROR: Immutable artifact ${DATA_ARTIFACT_URI:-<unset>} must be available for CURRENT_COMMIT=${CURRENT_COMMIT}."
      DATA_STOP_REASON="ARTIFACT_UNAVAILABLE"
    else
      log "ERROR: Package the Data stack (ci/build.sh) for this manual/emergency run."
      if [ "${DATA_STOP_REASON}" != "OWNERSHIP_UNVERIFIED" ]; then
        DATA_STOP_REASON="INCOMPATIBLE_CONFIGURATION"
      fi
    fi
    return 0
  fi

  log "Comparing live table to artifact ${DATA_ARTIFACT_URI:-$template_path}"

  backups_json='{}'
  set +e
  backups_json="$(aws dynamodb describe-continuous-backups \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  backups_rc=$?
  set -e
  if [ "$backups_rc" -ne 0 ]; then
    log "Configuration validation: INCOMPATIBLE"
    log "ERROR: dynamodb describe-continuous-backups failed for ${DATA_TABLE_NAME}."
    log "ERROR: ${backups_json}"
    if [ "${DATA_STOP_REASON}" != "OWNERSHIP_UNVERIFIED" ]; then
      DATA_STOP_REASON="INCOMPATIBLE_CONFIGURATION"
    fi
    return 0
  fi

  config_result="$(
    TABLE_JSON="${TABLE_JSON}" \
    BACKUPS_JSON="${backups_json}" \
    TEMPLATE_PATH="${template_path}" \
    EXPECTED_TABLE_NAME="$DATA_TABLE_NAME" \
    EXPECTED_LOGICAL_ID="$DATA_LOGICAL_ID" \
    node <<'NODE'
const fs = require('fs');

const errors = [];
const tableWrap = JSON.parse(process.env.TABLE_JSON || '{}');
const table = tableWrap.Table || {};
const backups = JSON.parse(process.env.BACKUPS_JSON || '{}');
const expectedName = process.env.EXPECTED_TABLE_NAME;
const raw = fs.readFileSync(process.env.TEMPLATE_PATH, 'utf8');

let template;
try {
  template = JSON.parse(raw);
} catch (e) {
  process.stdout.write(JSON.stringify({
    state: 'INCOMPATIBLE',
    errors: [`Data template is not JSON (packaged.yaml from serverless package is required): ${e.message}`],
  }));
  process.exit(0);
}

const resources = template.Resources || {};
const workflowTable = resources[process.env.EXPECTED_LOGICAL_ID];
if (!workflowTable || workflowTable.Type !== 'AWS::DynamoDB::Table') {
  process.stdout.write(JSON.stringify({
    state: 'INCOMPATIBLE',
    errors: [`Data template is missing AWS::DynamoDB::Table resource ${process.env.EXPECTED_LOGICAL_ID}`],
  }));
  process.exit(0);
}

const expected = workflowTable.Properties || {};

function sortKeySchema(list) {
  return (list || []).map((k) => ({
    AttributeName: k.AttributeName,
    KeyType: k.KeyType,
  })).sort((a, b) => String(a.AttributeName).localeCompare(String(b.AttributeName)));
}

function sortAttrs(list) {
  return (list || []).map((a) => ({
    AttributeName: a.AttributeName,
    AttributeType: a.AttributeType,
  })).sort((a, b) => String(a.AttributeName).localeCompare(String(b.AttributeName)));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

if (table.TableName !== expectedName) {
  errors.push(`TableName is '${table.TableName || 'missing'}', expected '${expectedName}'`);
}
if (expected.TableName && table.TableName !== expected.TableName) {
  errors.push(`TableName is '${table.TableName || 'missing'}', template expects '${expected.TableName}'`);
}

const liveKeys = sortKeySchema(table.KeySchema);
const expectedKeys = sortKeySchema(expected.KeySchema);
if (!sameJson(liveKeys, expectedKeys)) {
  errors.push(`KeySchema is ${JSON.stringify(liveKeys)}, expected ${JSON.stringify(expectedKeys)}`);
}

const liveAttrs = sortAttrs(table.AttributeDefinitions);
const expectedAttrs = sortAttrs(expected.AttributeDefinitions);
if (!sameJson(liveAttrs, expectedAttrs)) {
  errors.push(`AttributeDefinitions are ${JSON.stringify(liveAttrs)}, expected ${JSON.stringify(expectedAttrs)}`);
}

const liveBilling = (table.BillingModeSummary && table.BillingModeSummary.BillingMode) || table.BillingMode || '';
const expectedBilling = expected.BillingMode || (expected.ProvisionedThroughput ? 'PROVISIONED' : '');
if (expectedBilling && liveBilling !== expectedBilling) {
  errors.push(`BillingMode is '${liveBilling || 'missing'}', expected '${expectedBilling}'`);
}
if (expectedBilling === 'PROVISIONED' && expected.ProvisionedThroughput) {
  const livePt = table.ProvisionedThroughput || {};
  const expPt = expected.ProvisionedThroughput;
  if (Number(livePt.ReadCapacityUnits) !== Number(expPt.ReadCapacityUnits)
    || Number(livePt.WriteCapacityUnits) !== Number(expPt.WriteCapacityUnits)) {
    errors.push(`ProvisionedThroughput is RCU=${livePt.ReadCapacityUnits}/WCU=${livePt.WriteCapacityUnits}, expected RCU=${expPt.ReadCapacityUnits}/WCU=${expPt.WriteCapacityUnits}`);
  }
}

const liveGsis = table.GlobalSecondaryIndexes || [];
const expectedGsis = expected.GlobalSecondaryIndexes || [];
if (liveGsis.length !== expectedGsis.length) {
  errors.push(`GlobalSecondaryIndexes count is ${liveGsis.length}, expected ${expectedGsis.length}`);
} else {
  const liveByName = {};
  for (const g of liveGsis) liveByName[g.IndexName] = g;
  for (const g of expectedGsis) {
    const live = liveByName[g.IndexName];
    if (!live) {
      errors.push(`GSI '${g.IndexName}' is missing on the live table`);
      continue;
    }
    if (!sameJson(sortKeySchema(live.KeySchema), sortKeySchema(g.KeySchema))) {
      errors.push(`GSI '${g.IndexName}' KeySchema does not match the Data template`);
    }
  }
}

const liveLsis = table.LocalSecondaryIndexes || [];
const expectedLsis = expected.LocalSecondaryIndexes || [];
if (liveLsis.length !== expectedLsis.length) {
  errors.push(`LocalSecondaryIndexes count is ${liveLsis.length}, expected ${expectedLsis.length}`);
}

const expectedStream = expected.StreamSpecification || null;
const liveStream = table.StreamSpecification || {};
if (expectedStream) {
  if (liveStream.StreamEnabled === false) {
    errors.push('DynamoDB Streams are disabled');
  }
  if (liveStream.StreamViewType !== expectedStream.StreamViewType) {
    errors.push(`Stream view is '${liveStream.StreamViewType || 'missing'}', expected '${expectedStream.StreamViewType}'`);
  }
} else if (liveStream.StreamEnabled === true || liveStream.StreamViewType) {
  errors.push('Live table has streams; Data template does not define StreamSpecification');
}

const expectedPitr = expected.PointInTimeRecoverySpecification;
if (expectedPitr && expectedPitr.PointInTimeRecoveryEnabled === true) {
  const pitr = (((backups.ContinuousBackupsDescription || {}).PointInTimeRecoveryDescription || {}).PointInTimeRecoveryStatus);
  if (pitr !== 'ENABLED') {
    errors.push(`Point-in-Time Recovery is '${pitr || 'missing'}', expected ENABLED`);
  }
}

const liveStatus = table.TableStatus || '';
if (liveStatus && liveStatus !== 'ACTIVE') {
  errors.push(`TableStatus is '${liveStatus}', expected ACTIVE`);
}

process.stdout.write(JSON.stringify({
  state: errors.length ? 'INCOMPATIBLE' : 'COMPATIBLE',
  errors,
  templatePath: process.env.TEMPLATE_PATH,
}));
NODE
  )"

  DATA_TABLE_CONFIGURATION="$(RESULT_JSON="$config_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "INCOMPATIBLE");
  ')"

  log "Configuration validation: ${DATA_TABLE_CONFIGURATION}"
  if [ "${DATA_TABLE_CONFIGURATION}" != "COMPATIBLE" ]; then
    if [ "${DATA_STOP_REASON}" != "OWNERSHIP_UNVERIFIED" ]; then
      DATA_STOP_REASON="INCOMPATIBLE_CONFIGURATION"
    fi
    log "ERROR: Existing DynamoDB table configuration is incompatible with the Data template."
    log "ERROR: The table was not modified."
    RESULT_JSON="$config_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const err of r.errors || []) {
        console.log("[DATA-PREFLIGHT] ERROR: " + err);
      }
    '
    log "ERROR: Deployment is stopped. Fix the mismatch or use a future recovery workflow after review."
  fi
}

log "Starting Data preflight"
log "stage=${STAGE} region=${AWS_REGION} service=${OWNERSHIP_TAG_SERVICE}"
log "stack=${DATA_STACK_NAME} table=${DATA_TABLE_NAME}"

TABLE_JSON=""
TABLE_ARN=""
TABLE_TAGS_FAILED=0

if ! resolve_packaged_data_template; then
  DATA_ACTION="STOP"
  DATA_STOP_REASON="ARTIFACT_UNAVAILABLE"
  DATA_TABLE_STATE="NOT_CHECKED"
  finish
  exit 0
fi

if ! describe_data_stack; then
  DATA_ACTION="STOP"
  DATA_TABLE_STATE="NOT_CHECKED"
  finish
  exit 0
fi

if [ "${DATA_STACK_STATE}" = "EXISTS" ]; then
  if stack_is_usable "${DATA_STACK_STATUS}"; then
    if validate_managed_workflow_table; then
      DATA_ACTION="UPDATE"
      DATA_TABLE_OWNERSHIP="NOT_APPLICABLE"
      DATA_TABLE_CONFIGURATION="NOT_APPLICABLE"
      log "Stack is usable and ${DATA_LOGICAL_ID} is the expected managed DynamoDB table."
    fi
    finish
    exit 0
  fi

  DATA_ACTION="STOP"
  DATA_TABLE_STATE="NOT_CHECKED"

  case "${DATA_STACK_STATUS}" in
    REVIEW_IN_PROGRESS)
      DATA_STOP_REASON="STACK_UNSAFE"
      log "ERROR: Data stack ${DATA_STACK_NAME} is in REVIEW_IN_PROGRESS."
      log "ERROR: REVIEW_IN_PROGRESS is not considered a usable or recoverable deployment state."
      log "ERROR: The stack may represent an incomplete CloudFormation create/review operation."
      log "ERROR: Deployment is stopped. No CREATE, UPDATE, IMPORT, or rollback will be executed automatically."
      ;;

    *_IN_PROGRESS)
      DATA_STOP_REASON="STACK_IN_PROGRESS"
      log "ERROR: Data stack ${DATA_STACK_NAME} is in progress (${DATA_STACK_STATUS})."
      log "ERROR: Deployment is stopped to avoid racing an in-flight CloudFormation operation."
      log "ERROR: ContinueUpdateRollback is not executed automatically."
      ;;

    *)
      DATA_STOP_REASON="STACK_UNSAFE"
      log "ERROR: Data stack ${DATA_STACK_NAME} is not in a usable state (${DATA_STACK_STATUS})."
      log "ERROR: Usable states are CREATE_COMPLETE, UPDATE_COMPLETE, IMPORT_COMPLETE, UPDATE_ROLLBACK_COMPLETE."
      log "ERROR: Failed or rolled-back stacks are not treated as healthy. Deployment is stopped."
      ;;
  esac

  finish
  exit 0
fi

# Stack is NOT_FOUND. Classify the expected DynamoDB table before any
# ownership or configuration validation. A missing table is CREATE.
if ! describe_workflow_table; then
  DATA_ACTION="STOP"
  finish
  exit 0
fi

if [ "${DATA_TABLE_STATE}" = "NOT_FOUND" ]; then
  DATA_ACTION="CREATE"
  DATA_TABLE_OWNERSHIP="NOT_APPLICABLE"
  DATA_TABLE_CONFIGURATION="NOT_APPLICABLE"
  finish
  exit 0
fi

if [ "${DATA_TABLE_STATE}" != "EXISTS" ]; then
  DATA_ACTION="STOP"
  DATA_STOP_REASON="${DATA_STOP_REASON:-DYNAMODB_API_ERROR}"
  finish
  exit 0
fi

validate_table_ownership
validate_table_configuration

if [ "${DATA_TABLE_OWNERSHIP}" != "VERIFIED" ]; then
  DATA_ACTION="STOP"
  DATA_STOP_REASON="OWNERSHIP_UNVERIFIED"
elif [ "${DATA_TABLE_CONFIGURATION}" != "COMPATIBLE" ]; then
  DATA_ACTION="STOP"
  DATA_STOP_REASON="${DATA_STOP_REASON:-INCOMPATIBLE_CONFIGURATION}"
else
  DATA_ACTION="RECOVERY_REQUIRED"
  DATA_STOP_REASON=""
fi

finish
exit 0
