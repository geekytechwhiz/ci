#!/bin/bash
# Prepare, but do not execute, a CloudFormation IMPORT change set for the
# retained DynamoDB table.
#
# Used only when data-preflight.sh wrote DATA_ACTION=RECOVERY_REQUIRED.
# Re-validates live stack/table/ownership/configuration against the immutable
# Data artifact, then creates an IMPORT-ONLY change set for ${DATA_LOGICAL_ID}.
#
# Does not execute the change set.
# Does not CloudFormation CREATE or UPDATE.
# Does not modify, delete, or recreate the DynamoDB table.
# Never falls back to a local packaged.yaml when CURRENT_COMMIT is set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
: "${DATA_STACK_NAME:?DATA_STACK_NAME must be set}"

assert_stage
assert_codebuild_stage_match
assume_data_recovery_role_if_configured


PREFLIGHT_ENV="$(resolve_data_preflight_env)"
RECOVERY_ENV="$(resolve_data_recovery_env)"
WORKDIR="${DATA_RECOVERY_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/data-recovery-prepare.XXXXXX")}"
mkdir -p "$WORKDIR"
IMPORT_TEMPLATE="${WORKDIR}/import-template.json"
RESOURCES_TO_IMPORT="${WORKDIR}/resources-to-import.json"

DATA_ARTIFACT_URI=""
PACKAGED_TEMPLATE_PATH=""
TABLE_JSON=""
TABLE_ARN=""
TABLE_TAGS_FAILED=0
TAGS_JSON='{"Tags":[]}'
CHANGE_SET_NAME=""
CHANGE_SET_ARN=""
OWNERSHIP_STATE="NOT_CHECKED"
CONFIGURATION_STATE="NOT_CHECKED"
STACK_EXISTS_STATUS=""
DATA_REASON="stack missing; existing table ownership verified"

log() {
  echo "[DATA-RECOVERY-PREPARE] $*"
}

fail_stop() {
  log "ERROR: $*"
  log "ERROR: Recovery preparation STOPPED. The change set is not approval-ready."
  log "ERROR: The DynamoDB table was not deleted, recreated, imported, or modified."
  log "ERROR: execute-change-set was not called."
  exit 1
}

cfn_role_args() {
  cfn_data_recovery_role_args
}

discard_change_set() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    return 0
  fi
  log "Discarding change set ${name} so it is not approval-ready."
  aws cloudformation delete-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$name" >/dev/null 2>&1 || true
}

write_recovery_env() {
  local tmp
  mkdir -p "$(dirname "$RECOVERY_ENV")"
  tmp="${RECOVERY_ENV}.tmp.$$"
  {
    echo "DATA_ACTION=RECOVERY_REQUIRED"
    printf 'DATA_REASON=%q\n' "$DATA_REASON"
    echo "RECOVERY_REQUIRED=true"
    echo "RECOVERY_STATUS=APPROVAL_REQUIRED"
    echo "DATA_STACK_NAME=${DATA_STACK_NAME}"
    echo "DATA_TABLE_NAME=${DATA_TABLE_NAME}"
    echo "CURRENT_COMMIT=${CURRENT_COMMIT}"
    echo "DATA_ARTIFACT_URI=${DATA_ARTIFACT_URI}"
    echo "CHANGE_SET_NAME=${CHANGE_SET_NAME}"
    echo "CHANGE_SET_ARN=${CHANGE_SET_ARN}"
    echo "RECOVERY_CHANGE_SET_NAME=${CHANGE_SET_NAME}"
    echo "RECOVERY_STACK_NAME=${DATA_STACK_NAME}"
    echo "RECOVERY_TABLE_NAME=${DATA_TABLE_NAME}"
    echo "RECOVERY_STAGE=${STAGE}"
  } >"$tmp"
  mv "$tmp" "$RECOVERY_ENV"
  log "Wrote $RECOVERY_ENV"
}

deterministic_recovery_change_set_name() {
  printf 'recovery-%s-%s-%s' "$SERVICE_NAME" "$STAGE" "$CURRENT_COMMIT"
}

print_recovery_summary() {
  echo "======================================="
  echo "DATA STACK RECOVERY PREPARATION SUMMARY"
  echo "======================================="
  echo "service: ${OWNERSHIP_TAG_SERVICE}"
  echo "stage: ${STAGE}"
  echo "stack: ${DATA_STACK_NAME}"
  echo "table: ${DATA_TABLE_NAME}"
  echo "logical ID: ${DATA_LOGICAL_ID}"
  echo "resource type: AWS::DynamoDB::Table"
  echo "commit: ${CURRENT_COMMIT}"
  echo "artifact URI: ${DATA_ARTIFACT_URI}"
  echo "ownership validation: ${OWNERSHIP_STATE}"
  echo "configuration validation: ${CONFIGURATION_STATE}"
  echo "exact import action: Import ${DATA_LOGICAL_ID} (AWS::DynamoDB::Table)"
  echo "destructive operations: NONE"
  echo "data deletion: NONE"
  echo "approval required: YES"
  echo "change set: ${CHANGE_SET_NAME}"
  echo "change set ARN: ${CHANGE_SET_ARN}"
  echo "======================================="
}

fetch_immutable_data_artifact() {
  local dest rc=0

  if [ -z "${CURRENT_COMMIT:-}" ]; then
    fail_stop "CURRENT_COMMIT is missing. Recovery preparation requires the immutable S3 Data artifact and must not use a local packaged.yaml."
  fi

  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    fail_stop "CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path."
  fi

  if ! DATA_ARTIFACT_URI="$(immutable_packaged_template_s3_uri data)"; then
    fail_stop "Cannot resolve immutable Data artifact URI for CURRENT_COMMIT=${CURRENT_COMMIT}."
  fi

  dest="$(mktemp "${WORKDIR}/data-packaged.XXXXXX")"
  log "Fetching immutable Data artifact ${DATA_ARTIFACT_URI}"
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

describe_data_stack_or_fail() {
  local output rc=0 status

  log "Checking CloudFormation stack ${DATA_STACK_NAME} in ${AWS_REGION}"
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qi 'does not exist'; then
      log "Data stack state: NOT_FOUND"
      return 0
    fi
    log "ERROR: ${output}"
    fail_stop "CloudFormation describe-stacks failed for ${DATA_STACK_NAME}."
  fi

  status="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ -z "$status" ] || [ "$status" = "None" ] || [ "$status" = "DELETE_COMPLETE" ]; then
    log "Data stack state: NOT_FOUND"
    return 0
  fi

  # Creating an IMPORT change set for a new stack leaves REVIEW_IN_PROGRESS
  # until execute-change-set. A retried prepare must reuse that change set.
  if [ "$status" = "REVIEW_IN_PROGRESS" ]; then
    STACK_EXISTS_STATUS="REVIEW_IN_PROGRESS"
    log "Data stack state: REVIEW_IN_PROGRESS (IMPORT change set pending execution; retry-safe)"
    return 0
  fi

  case "$status" in
    ROLLBACK_FAILED|UPDATE_ROLLBACK_FAILED|IMPORT_ROLLBACK_FAILED|DELETE_FAILED)
      print_cfn_failure_diagnostics "${DATA_STACK_NAME}"
      fail_stop "Data stack is ${status}. IMPORT cannot run until the failed rollback is repaired. Physical resources were not deleted."
      ;;
    ROLLBACK_COMPLETE|CREATE_FAILED|IMPORT_ROLLBACK_COMPLETE|IMPORT_FAILED)
      STACK_EXISTS_STATUS="$status"
      log "Data stack is ${status} and cannot be updated. Preparing IMPORT requires removing the failed stack record only."
      log "DeletionPolicy Retain keeps the DynamoDB table. The table will not be deleted."
      return 0
      ;;
  esac

  fail_stop "Data stack unexpectedly exists (${status}). Refusing to prepare an IMPORT change set against a live stack."
}

describe_workflow_table_or_fail() {
  local output rc=0 status

  log "Checking DynamoDB table ${DATA_TABLE_NAME}"
  set +e
  output="$(aws dynamodb describe-table \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'ResourceNotFoundException|Requested resource not found'; then
      fail_stop "DynamoDB table does not exist (${DATA_TABLE_NAME}). Recovery preparation will not CREATE the table."
    fi
    log "ERROR: ${output}"
    fail_stop "dynamodb describe-table failed for ${DATA_TABLE_NAME}."
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
  if [ "$status" != "ACTIVE" ]; then
    fail_stop "Table is not ACTIVE (status=${status:-missing}). Recovery preparation is stopped."
  fi
}

load_table_tags() {
  local output rc=0
  TAGS_JSON='{"Tags":[]}'
  TABLE_TAGS_FAILED=0

  if [ -z "${TABLE_ARN}" ]; then
    TABLE_TAGS_FAILED=1
    return 0
  fi

  set +e
  output="$(aws dynamodb list-tags-of-resource \
    --region "$AWS_REGION" \
    --resource-arn "$TABLE_ARN" \
    --output json 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "ERROR: dynamodb list-tags-of-resource failed for ${TABLE_ARN}."
    log "ERROR: ${output}"
    TABLE_TAGS_FAILED=1
    TAGS_JSON='{"Tags":[]}'
    return 0
  fi
  TAGS_JSON="$output"
}

validate_not_managed_by_other_stack() {
  local result stack_name stack_id output rc=0 status

  result="$(
    TAGS_JSON="${TAGS_JSON}" \
    EXPECTED_STACK="${DATA_STACK_NAME}" \
    node <<'NODE'
const tagsWrap = JSON.parse(process.env.TAGS_JSON || '{"Tags":[]}');
const tags = Array.isArray(tagsWrap.Tags) ? tagsWrap.Tags : [];
const tagMap = {};
for (const t of tags) {
  if (t && t.Key) tagMap[t.Key] = t.Value;
}
const expected = process.env.EXPECTED_STACK;
const stackName = tagMap['aws:cloudformation:stack-name'] || '';
const stackId = tagMap['aws:cloudformation:stack-id'] || '';
const logicalId = tagMap['aws:cloudformation:logical-id'] || '';
process.stdout.write(JSON.stringify({
  stackName,
  stackId,
  logicalId,
  otherStack: Boolean(stackName && stackName !== expected),
}));
NODE
  )"

  stack_name="$(RESULT_JSON="$result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.stackName || "");
  ')"
  stack_id="$(RESULT_JSON="$result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.stackId || "");
  ')"

  if [ -z "$stack_name" ] && [ -z "$stack_id" ]; then
    return 0
  fi

  # Leftover tags pointing at the expected Data stack are allowed only when
  # that stack is already confirmed missing. Any other live stack is STOP.
  if [ -n "$stack_name" ] && [ "$stack_name" = "$DATA_STACK_NAME" ] && [ -z "$stack_id" ]; then
    return 0
  fi

  local probe="${stack_id:-$stack_name}"
  if [ -z "$probe" ] || [ "$probe" = "$DATA_STACK_NAME" ]; then
    return 0
  fi

  log "Table has CloudFormation tags for stack ${probe}. Checking whether that stack still exists."
  set +e
  output="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$probe" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qi 'does not exist'; then
      log "Tagged CloudFormation stack ${probe} does not exist. Treating tags as leftover from a deleted stack."
      return 0
    fi
    log "ERROR: ${output}"
    fail_stop "Cannot confirm whether ${DATA_TABLE_NAME} is already managed by CloudFormation stack ${probe}."
  fi

  status="$(DATA_STACK_JSON="$output" node -e '
    const s = JSON.parse(process.env.DATA_STACK_JSON);
    const stack = (s.Stacks && s.Stacks[0]) || {};
    process.stdout.write(stack.StackStatus || "");
  ')"

  if [ -n "$status" ] && [ "$status" != "DELETE_COMPLETE" ] && [ "$status" != "None" ]; then
    fail_stop "Table appears to already be managed by CloudFormation stack ${probe} (${status})."
  fi
}

validate_table_ownership() {
  local caller_json caller_arn caller_account ownership_result rc=0

  OWNERSHIP_STATE="UNVERIFIED"

  set +e
  caller_json="$(aws sts get-caller-identity --output json 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "ERROR: sts get-caller-identity failed. ${caller_json}"
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

  OWNERSHIP_STATE="$(RESULT_JSON="$ownership_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "UNVERIFIED");
  ')"
  log "Ownership validation: ${OWNERSHIP_STATE} (caller ${caller_arn})"

  if [ "${OWNERSHIP_STATE}" != "VERIFIED" ]; then
    RESULT_JSON="$ownership_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const reason of r.reasons || []) {
        console.log("[DATA-RECOVERY-PREPARE] ERROR: " + reason);
      }
    '
    fail_stop "Required ownership tags do not match for ${DATA_TABLE_NAME}."
  fi
}

validate_table_configuration() {
  local backups_json backups_rc=0 config_result

  CONFIGURATION_STATE="INCOMPATIBLE"

  if [ -z "${PACKAGED_TEMPLATE_PATH}" ] || [ ! -f "${PACKAGED_TEMPLATE_PATH}" ]; then
    fail_stop "Immutable Data artifact is unavailable. Cannot compare live table configuration."
  fi

  backups_json='{}'
  set +e
  backups_json="$(aws dynamodb describe-continuous-backups \
    --region "$AWS_REGION" \
    --table-name "$DATA_TABLE_NAME" \
    --output json 2>&1)"
  backups_rc=$?
  set -e
  if [ "$backups_rc" -ne 0 ]; then
    log "ERROR: ${backups_json}"
    fail_stop "dynamodb describe-continuous-backups failed. Table configuration cannot be validated."
  fi

  config_result="$(
    TABLE_JSON="${TABLE_JSON}" \
    BACKUPS_JSON="${backups_json}" \
    TEMPLATE_PATH="${PACKAGED_TEMPLATE_PATH}" \
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
    errors: [`Data template is not JSON: ${e.message}`],
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
}));
NODE
  )"

  CONFIGURATION_STATE="$(RESULT_JSON="$config_result" node -e '
    const r = JSON.parse(process.env.RESULT_JSON);
    process.stdout.write(r.state || "INCOMPATIBLE");
  ')"
  log "Configuration validation: ${CONFIGURATION_STATE}"

  if [ "${CONFIGURATION_STATE}" != "COMPATIBLE" ]; then
    RESULT_JSON="$config_result" node -e '
      const r = JSON.parse(process.env.RESULT_JSON);
      for (const err of r.errors || []) {
        console.log("[DATA-RECOVERY-PREPARE] ERROR: " + err);
      }
    '
    fail_stop "Table configuration is incompatible with the immutable Data template."
  fi
}

generate_import_artifacts() {
  log "Generating IMPORT-ONLY template and resources-to-import.json from ${DATA_ARTIFACT_URI}"

  TEMPLATE_PATH="${PACKAGED_TEMPLATE_PATH}" \
  DEST_TEMPLATE="${IMPORT_TEMPLATE}" \
  DEST_IMPORT="${RESOURCES_TO_IMPORT}" \
  EXPECTED_TABLE_NAME="${DATA_TABLE_NAME}" \
  EXPECTED_LOGICAL_ID="${DATA_LOGICAL_ID}" \
  node <<'NODE'
const fs = require('fs');
const template = JSON.parse(fs.readFileSync(process.env.TEMPLATE_PATH, 'utf8'));
const resources = template.Resources || {};
const workflowTable = resources[process.env.EXPECTED_LOGICAL_ID];
if (!workflowTable || workflowTable.Type !== 'AWS::DynamoDB::Table') {
  console.error('[DATA-RECOVERY-PREPARE] ERROR: Immutable Data template is missing AWS::DynamoDB::Table ' + process.env.EXPECTED_LOGICAL_ID);
  process.exit(1);
}

const logicalId = process.env.EXPECTED_LOGICAL_ID;
const importTemplate = {
  AWSTemplateFormatVersion: template.AWSTemplateFormatVersion || '2010-09-09',
  Description: 'IMPORT-ONLY template for retained DynamoDB table. Contains no other resources.',
  Resources: {
    [logicalId]: {
      Type: 'AWS::DynamoDB::Table',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: workflowTable.Properties || {},
    },
  },
};

const resourceIds = Object.keys(importTemplate.Resources);
if (resourceIds.length !== 1 || resourceIds[0] !== logicalId) {
  console.error('[DATA-RECOVERY-PREPARE] ERROR: Import template must contain only ' + logicalId);
  process.exit(1);
}

fs.writeFileSync(process.env.DEST_TEMPLATE, JSON.stringify(importTemplate, null, 2) + '\n');
const artifactTableName = workflowTable.Properties && workflowTable.Properties.TableName;
if (!artifactTableName || typeof artifactTableName !== 'string') {
  console.error('[DATA-RECOVERY-PREPARE] ERROR: Data artifact TableName is missing or not a literal string');
  process.exit(1);
}
if (process.env.EXPECTED_TABLE_NAME && process.env.EXPECTED_TABLE_NAME !== artifactTableName) {
  console.error('[DATA-RECOVERY-PREPARE] ERROR: Env table name ' + process.env.EXPECTED_TABLE_NAME + ' does not match artifact TableName ' + artifactTableName);
  process.exit(1);
}
fs.writeFileSync(process.env.DEST_IMPORT, JSON.stringify([
  {
    ResourceType: 'AWS::DynamoDB::Table',
    LogicalResourceId: logicalId,
    ResourceIdentifier: {
      TableName: artifactTableName,
    },
  },
], null, 2) + '\n');
NODE
}

write_stop_recovery_env() {
  local tmp
  mkdir -p "$(dirname "$RECOVERY_ENV")"
  tmp="${RECOVERY_ENV}.tmp.$$"
  {
    echo "DATA_ACTION=STOP"
    printf 'DATA_REASON=%q\n' "change set failed machine validation"
    echo "RECOVERY_REQUIRED=false"
    echo "RECOVERY_STATUS=STOP"
    echo "DATA_STACK_NAME=${DATA_STACK_NAME}"
    echo "DATA_TABLE_NAME=${DATA_TABLE_NAME}"
    echo "CURRENT_COMMIT=${CURRENT_COMMIT:-}"
    echo "CHANGE_SET_NAME=${CHANGE_SET_NAME}"
    echo "RECOVERY_CHANGE_SET_NAME="
    echo "RECOVERY_STACK_NAME=${DATA_STACK_NAME}"
    echo "RECOVERY_TABLE_NAME=${DATA_TABLE_NAME}"
  } >"$tmp"
  mv "$tmp" "$RECOVERY_ENV"
  log "Wrote STOP recovery state to $RECOVERY_ENV"
}

# Approval-readiness is proven from DescribeChangeSet Status, ExecutionStatus,
# and Changes[]. ResourceChange — not from ChangeSetType. AWS CreateChangeSet
# accepts --change-set-type IMPORT, but DescribeChangeSet does not return
# ChangeSetType.
validate_change_set() {
  local change_set_json="$1"
  local validation

  if [ -z "$change_set_json" ]; then
    discard_change_set "$CHANGE_SET_NAME"
    write_stop_recovery_env
    fail_stop "Change set does not exist. It is not approval-ready."
  fi

  validation="$(
    CHANGE_SET_JSON="$change_set_json" \
    EXPECTED_TABLE="$DATA_TABLE_NAME" \
    EXPECTED_STACK="$DATA_STACK_NAME" \
    EXPECTED_LOGICAL_ID="$DATA_LOGICAL_ID" \
    node <<'NODE'
const cs = JSON.parse(process.env.CHANGE_SET_JSON || '{}');
const errors = [];
const expectedTable = process.env.EXPECTED_TABLE || '';
const expectedStack = process.env.EXPECTED_STACK || '';
const changes = Array.isArray(cs.Changes) ? cs.Changes : [];
const resourceChanges = changes.filter((c) => c && (c.Type === 'Resource' || c.ResourceChange));

if (!cs.ChangeSetName && !cs.ChangeSetId && !cs.Id && !cs.Status && changes.length === 0) {
  errors.push('Change set does not exist');
}
if (cs.Status !== 'CREATE_COMPLETE') {
  errors.push(`Status is '${cs.Status || 'missing'}', expected CREATE_COMPLETE`);
}
if (cs.ExecutionStatus !== 'AVAILABLE') {
  errors.push(`ExecutionStatus is '${cs.ExecutionStatus || 'missing'}', expected AVAILABLE`);
}
if (expectedStack && cs.StackName && cs.StackName !== expectedStack) {
  errors.push(`StackName is '${cs.StackName}', expected '${expectedStack}'`);
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

  if (change.Type !== 'Resource') {
    errors.push(`Change Type is '${change.Type || 'missing'}', expected Resource`);
  }
  if (action === 'Add' || action === 'Create') {
    errors.push(`Change set contains Add of ${logical || 'unknown'} (${type || 'unknown'})`);
    errors.push(`Change set contains Create of ${logical || 'unknown'} (${type || 'unknown'})`);
  }
  if (action === 'Modify') {
    errors.push(`Change set contains Modify of ${logical || 'unknown'} (${type || 'unknown'})`);
  }
  if (action === 'Remove' || action === 'Delete') {
    errors.push(`Change set contains Remove of ${logical || 'unknown'} (${type || 'unknown'})`);
    errors.push(`Change set contains Delete of ${logical || 'unknown'} (${type || 'unknown'})`);
  }
  if (replacement === 'True' || replacement === 'Conditional') {
    errors.push(`Change set contains Replace of ${logical || 'unknown'} (Replacement=${replacement})`);
  }
  if (logical !== process.env.EXPECTED_LOGICAL_ID) {
    errors.push(`Additional resource ${logical || 'missing'} is not allowed in the IMPORT change set`);
  }
  if (type !== 'AWS::DynamoDB::Table') {
    errors.push(`ResourceType is '${type || 'missing'}', expected AWS::DynamoDB::Table`);
  }
  if (action === 'Import' && logical === process.env.EXPECTED_LOGICAL_ID && type === 'AWS::DynamoDB::Table' && change.Type === 'Resource') {
    importOk = true;
  } else if (action !== 'Import') {
    errors.push(`Action is '${action || 'missing'}', expected Import`);
  }
  if (expectedTable && rc.PhysicalResourceId && rc.PhysicalResourceId !== expectedTable) {
    errors.push(`PhysicalResourceId is '${rc.PhysicalResourceId}', expected '${expectedTable}'`);
  }
}

if (!importOk) {
  errors.push(`Change set does not contain the exact expected Import of ${process.env.EXPECTED_LOGICAL_ID} (AWS::DynamoDB::Table)`);
}

process.stdout.write(errors.length ? `NO\n${errors.join('\n')}` : 'YES');
NODE
  )"

  if [ "${validation}" != "YES" ]; then
    printf '%s\n' "${validation}" | sed 's/^/[DATA-RECOVERY-PREPARE] ERROR: /'
    discard_change_set "$CHANGE_SET_NAME"
    write_stop_recovery_env
    fail_stop "Change set failed machine validation. It is not approval-ready."
  fi
}

# Returns 0 when CHANGE_SET_NAME already exists, is AVAILABLE, and is a safe IMPORT.
reuse_existing_change_set_if_valid() {
  local output rc=0 status execution

  set +e
  output="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME" \
    --output json 2>&1)"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$output" | grep -qiE 'does not exist|ChangeSetNotFound|not found'; then
      return 1
    fi
    log "ERROR: ${output}"
    fail_stop "cloudformation describe-change-set failed for existing change set ${CHANGE_SET_NAME}."
  fi

  status="$(CHANGE_SET_JSON="$output" node -e '
    const d = JSON.parse(process.env.CHANGE_SET_JSON || "{}");
    process.stdout.write(d.Status || "");
  ')"
  execution="$(CHANGE_SET_JSON="$output" node -e '
    const d = JSON.parse(process.env.CHANGE_SET_JSON || "{}");
    process.stdout.write(d.ExecutionStatus || "");
  ')"
  CHANGE_SET_ARN="$(CHANGE_SET_JSON="$output" node -e '
    const d = JSON.parse(process.env.CHANGE_SET_JSON || "{}");
    process.stdout.write(d.ChangeSetId || d.Id || "");
  ')"

  if [ "$status" = "FAILED" ] || [ "$execution" = "UNAVAILABLE" ] || [ "$execution" = "OBSOLETE" ]; then
    log "Existing change set ${CHANGE_SET_NAME} is not reusable (Status=${status} ExecutionStatus=${execution}). Discarding."
    discard_change_set "$CHANGE_SET_NAME"
    CHANGE_SET_ARN=""
    return 1
  fi

  if [ "$execution" = "EXECUTE_COMPLETE" ] || [ "$execution" = "EXECUTE_IN_PROGRESS" ]; then
    fail_stop "Change set ${CHANGE_SET_NAME} is already ${execution}. Re-run recovery execution rather than preparing a duplicate IMPORT."
  fi

  validate_change_set "$output"
  log "Reusing existing IMPORT change set ${CHANGE_SET_NAME}"
  return 0
}

echo "======================================="
echo "DATA STACK RECOVERY PREPARATION"
echo "======================================="
echo "[DATA-RECOVERY] Recovery required"
echo "[DATA-RECOVERY] Stack is missing but retained DynamoDB table exists"
echo "[DATA-RECOVERY] Preparing IMPORT change set"

if [ ! -f "$PREFLIGHT_ENV" ]; then
  fail_stop "deployment-data-preflight.env was not found at ${PREFLIGHT_ENV}."
fi

set -a
# shellcheck disable=SC1090
source "$PREFLIGHT_ENV"
set +a

log "Consumed ${PREFLIGHT_ENV}"
log "DATA_ACTION=${DATA_ACTION:-}"
log "stack=${DATA_STACK_NAME} table=${DATA_TABLE_NAME}"

if [ "${DATA_ACTION:-}" != "RECOVERY_REQUIRED" ]; then
  fail_stop "DATA_ACTION='${DATA_ACTION:-}' is not RECOVERY_REQUIRED. Recovery preparation will not run."
fi

if [ -z "${CURRENT_COMMIT:-}" ]; then
  fail_stop "CURRENT_COMMIT is missing. Recovery preparation requires s3://\$ARTIFACT_BUCKET/\${SERVICE_NAME}/\$CURRENT_COMMIT/data/packaged.yaml."
fi

if [ -n "${DATA_ARTIFACT_COMMIT:-}" ] && [ "${DATA_ARTIFACT_COMMIT}" != "${CURRENT_COMMIT}" ]; then
  fail_stop "Preflight DATA_ARTIFACT_COMMIT=${DATA_ARTIFACT_COMMIT} does not match CURRENT_COMMIT=${CURRENT_COMMIT}."
fi

fetch_immutable_data_artifact
if ! apply_data_resource_identity_from_template "$PACKAGED_TEMPLATE_PATH"; then
  fail_stop "Could not read DynamoDB TableName from the service Data artifact."
fi
log "table=${DATA_TABLE_NAME} logicalId=${DATA_LOGICAL_ID}"
describe_data_stack_or_fail
describe_workflow_table_or_fail
load_table_tags
validate_not_managed_by_other_stack
validate_table_ownership
validate_table_configuration
generate_import_artifacts

if [ ! -s "$IMPORT_TEMPLATE" ] || [ ! -s "$RESOURCES_TO_IMPORT" ]; then
  fail_stop "Failed to generate import template or resources-to-import.json."
fi

CHANGE_SET_NAME="$(deterministic_recovery_change_set_name)"
log "IMPORT change set name: ${CHANGE_SET_NAME}"

case "${STACK_EXISTS_STATUS}" in
  ROLLBACK_COMPLETE|CREATE_FAILED|IMPORT_ROLLBACK_COMPLETE|IMPORT_FAILED)
    log "Removing failed CloudFormation stack record ${DATA_STACK_NAME} (${STACK_EXISTS_STATUS})."
    log "DeletionPolicy Retain keeps ${DATA_TABLE_NAME}. The table is not deleted or recreated."
    aws cloudformation delete-stack \
      --region "$AWS_REGION" \
      --stack-name "$DATA_STACK_NAME"
    if ! aws cloudformation wait stack-delete-complete \
      --region "$AWS_REGION" \
      --stack-name "$DATA_STACK_NAME"; then
      print_cfn_failure_diagnostics "${DATA_STACK_NAME}"
      fail_stop "Failed to delete the failed stack record ${DATA_STACK_NAME}. The DynamoDB table was not targeted for deletion."
    fi
    STACK_EXISTS_STATUS=""
    ;;
esac

reused_change_set=0
if [ "${STACK_EXISTS_STATUS}" = "REVIEW_IN_PROGRESS" ]; then
  log "Stack is REVIEW_IN_PROGRESS. Checking for an existing IMPORT change set before creating another."
  if reuse_existing_change_set_if_valid; then
    reused_change_set=1
  fi
fi

if [ "$reused_change_set" -eq 0 ]; then
  log "Creating IMPORT change set ${CHANGE_SET_NAME}"
  log "template-body=file://${IMPORT_TEMPLATE}"
  log "resources-to-import=file://${RESOURCES_TO_IMPORT}"

  create_out=""
  create_rc=0
  set +e
  # shellcheck disable=SC2046
  create_out="$(aws cloudformation create-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME" \
    --change-set-type IMPORT \
    --template-body "file://${IMPORT_TEMPLATE}" \
    --resources-to-import "file://${RESOURCES_TO_IMPORT}" \
    --output json \
    $(cfn_role_args) 2>&1)"
  create_rc=$?
  set -e

  if [ "$create_rc" -ne 0 ]; then
    if printf '%s' "$create_out" | grep -qiE 'already exists|AlreadyExists'; then
      log "Change set ${CHANGE_SET_NAME} already exists. Attempting reuse."
      if ! reuse_existing_change_set_if_valid; then
        log "ERROR: ${create_out}"
        fail_stop "cloudformation create-change-set failed and the existing change set is not reusable."
      fi
      reused_change_set=1
    else
      log "ERROR: ${create_out}"
      fail_stop "cloudformation create-change-set failed."
    fi
  fi
fi

if [ "$reused_change_set" -eq 0 ]; then
  CHANGE_SET_ARN="$(CREATE_JSON="$create_out" node -e '
    try {
      const d = JSON.parse(process.env.CREATE_JSON);
      process.stdout.write(d.Id || d.ChangeSetId || "");
    } catch (e) {
      process.stdout.write("");
    }
  ')"

  set +e
  aws cloudformation wait change-set-create-complete \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME"
  set -e

  CHANGE_SET_JSON="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK_NAME" \
    --change-set-name "$CHANGE_SET_NAME" \
    --output json)"

  if [ -z "${CHANGE_SET_ARN}" ]; then
    CHANGE_SET_ARN="$(CHANGE_SET_JSON="$CHANGE_SET_JSON" node -e '
      const d = JSON.parse(process.env.CHANGE_SET_JSON || "{}");
      process.stdout.write(d.ChangeSetId || d.Id || "");
    ')"
  fi

  validate_change_set "$CHANGE_SET_JSON"
fi

if [ -z "${CHANGE_SET_ARN}" ]; then
  discard_change_set "$CHANGE_SET_NAME"
  fail_stop "Change set ARN is missing after describe-change-set."
fi

write_recovery_env
print_recovery_summary

echo "[DATA-RECOVERY] IMPORT change set is approval-ready"
echo "[DATA-RECOVERY] Waiting for manual approval"
log "IMPORT change set is prepared and approval-ready. execute-change-set was not called."
echo "======================================="
echo "DATA STACK RECOVERY PREPARATION COMPLETED"
echo "======================================="
