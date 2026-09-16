#!/bin/bash
# Local contract tests for Data Preflight / Deploy-Data / CodePipeline variables.
# Does not call AWS. Run from repo: cicd/pipeline/scripts/test-data-deployment-contract.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILS=0
PASSES=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: $label (got '$actual', expected '$expected')"
    FAILS=$((FAILS + 1))
  fi
}

assert_ok() {
  local label="$1"
  shift
  if "$@" >/tmp/data-contract-ok.out 2>/tmp/data-contract-ok.err; then
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: $label (expected success)"
    cat /tmp/data-contract-ok.err || true
    FAILS=$((FAILS + 1))
  fi
}

assert_fail() {
  local label="$1"
  shift
  if "$@" >/tmp/data-contract-fail.out 2>/tmp/data-contract-fail.err; then
    echo "FAIL: $label (expected failure)"
    FAILS=$((FAILS + 1))
  else
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  fi
}

export SERVICE_NAME=cloud-formation-testing
export STAGE=dev
export AWS_REGION=us-east-1
export RESOURCE_NAME_PREFIX=nvdev-use1-mvx
export SSM_PREFIX=/nvdev-use1-mvx/workflow-service
export CODEBUILD_SRC_DIR="$(mktemp -d /tmp/data-contract.XXXXXX)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

echo "=== SSM_PREFIX is not rewritten from pipeline identity ==="
assert_eq "supplied SSM_PREFIX preserved" "$SSM_PREFIX" /nvdev-use1-mvx/workflow-service
assert_eq "pipeline SERVICE_NAME is not the SSM leaf namespace" "$SERVICE_NAME" cloud-formation-testing

echo "=== Data deployment state machine ==="
assert_eq "1 stack missing + table missing" \
  "$(classify_data_preflight_action NOT_FOUND '' NOT_FOUND NOT_APPLICABLE NOT_APPLICABLE 0)" CREATE
assert_eq "2 stack missing + table exists verified" \
  "$(classify_data_preflight_action NOT_FOUND '' EXISTS VERIFIED COMPATIBLE 0)" RECOVERY_REQUIRED
assert_eq "3 CREATE_COMPLETE + managed table" \
  "$(classify_data_preflight_action EXISTS CREATE_COMPLETE EXISTS NOT_APPLICABLE NOT_APPLICABLE 1)" UPDATE
assert_eq "4 UPDATE_COMPLETE + managed table" \
  "$(classify_data_preflight_action EXISTS UPDATE_COMPLETE EXISTS NOT_APPLICABLE NOT_APPLICABLE 1)" UPDATE
assert_eq "5 ROLLBACK_COMPLETE + table missing" \
  "$(classify_data_preflight_action EXISTS ROLLBACK_COMPLETE NOT_FOUND NOT_APPLICABLE NOT_APPLICABLE 0)" CREATE
assert_eq "6 ROLLBACK_COMPLETE + table exists verified" \
  "$(classify_data_preflight_action EXISTS ROLLBACK_COMPLETE EXISTS VERIFIED COMPATIBLE 0)" RECOVERY_REQUIRED
assert_eq "7 CREATE_FAILED + table missing" \
  "$(classify_data_preflight_action EXISTS CREATE_FAILED NOT_FOUND NOT_APPLICABLE NOT_APPLICABLE 0)" CREATE
assert_eq "8 CREATE_FAILED + table exists verified" \
  "$(classify_data_preflight_action EXISTS CREATE_FAILED EXISTS VERIFIED COMPATIBLE 0)" RECOVERY_REQUIRED
assert_eq "9 UPDATE_ROLLBACK_FAILED + table exists" \
  "$(classify_data_preflight_action EXISTS UPDATE_ROLLBACK_FAILED EXISTS VERIFIED COMPATIBLE 0)" STOP
assert_eq "UPDATE_ROLLBACK_COMPLETE + managed table" \
  "$(classify_data_preflight_action EXISTS UPDATE_ROLLBACK_COMPLETE EXISTS NOT_APPLICABLE NOT_APPLICABLE 1)" UPDATE
assert_eq "UPDATE_FAILED is STOP" \
  "$(classify_data_preflight_action EXISTS UPDATE_FAILED EXISTS VERIFIED COMPATIBLE 0)" STOP
assert_eq "10 unrelated table ownership unverified" \
  "$(classify_data_preflight_action NOT_FOUND '' EXISTS UNVERIFIED COMPATIBLE 0)" STOP

assert_eq "ROLLBACK_COMPLETE + unverified table is STOP" \
  "$(classify_data_preflight_action EXISTS ROLLBACK_COMPLETE EXISTS UNVERIFIED COMPATIBLE 0)" STOP
assert_eq "usable stack without managed table is STOP" \
  "$(classify_data_preflight_action EXISTS CREATE_COMPLETE EXISTS NOT_APPLICABLE NOT_APPLICABLE 0)" STOP
assert_eq "incompatible existing table is STOP" \
  "$(classify_data_preflight_action NOT_FOUND '' EXISTS VERIFIED INCOMPATIBLE 0)" STOP

echo "=== Failed stack-record delete allowlist ==="
assert_fail "refuse delete of CREATE_COMPLETE" \
  delete_failed_cfn_stack_record dummy-stack CREATE_COMPLETE
assert_fail "refuse delete of UPDATE_COMPLETE" \
  delete_failed_cfn_stack_record dummy-stack UPDATE_COMPLETE
assert_fail "refuse delete of UPDATE_ROLLBACK_FAILED" \
  delete_failed_cfn_stack_record dummy-stack UPDATE_ROLLBACK_FAILED

echo "=== Variable contract ==="
DATA_ACTION=CREATE
DATA_REASON=CREATE
RECOVERY_REQUIRED=false
CURRENT_COMMIT=953136a4def02e9618b99225510be8dcf483e622
RECOVERY_STACK_NAME=dev-cloud-formation-testing-data
RECOVERY_TABLE_NAME=nvdev-use1-mvx-workflow-service-db
RECOVERY_STAGE=dev
RECOVERY_CHANGE_SET_NAME=""
assert_ok "normal CREATE allows empty RECOVERY_CHANGE_SET_NAME" require_data_deployment_variables

RECOVERY_REQUIRED=true
assert_fail "recovery requires RECOVERY_CHANGE_SET_NAME" require_data_deployment_variables

RECOVERY_CHANGE_SET_NAME=recovery-cloud-formation-testing-dev-953136a4def02e9618b99225510be8dcf483e622
assert_ok "recovery with real change set name" require_data_deployment_variables

echo "=== promote-exported-variables CREATE ==="
CREATE_ENV="${CODEBUILD_SRC_DIR}/data-deployment-variables.env"
write_sourcable_env "$CREATE_ENV" \
  DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT
# Recreate empty change set for CREATE after the recovery test mutated it.
DATA_ACTION=CREATE
DATA_REASON=CREATE
RECOVERY_REQUIRED=false
RECOVERY_CHANGE_SET_NAME=""
write_sourcable_env "$CREATE_ENV" \
  DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT

# shellcheck disable=SC1091
source "$SCRIPT_DIR/promote-exported-variables.sh" \
  "$CREATE_ENV" \
  DATA_ACTION RECOVERY_REQUIRED CURRENT_COMMIT \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE DATA_REASON \
  RECOVERY_CHANGE_SET_NAME
assert_eq "promote CREATE DATA_ACTION" "${DATA_ACTION}" CREATE
assert_eq "promote CREATE RECOVERY_REQUIRED" "${RECOVERY_REQUIRED}" false
assert_eq "promote CREATE does not export empty change set" "${RECOVERY_CHANGE_SET_NAME-UNSET}" UNSET

echo "=== promote-exported-variables RECOVERY ==="
RECOVERY_REQUIRED=true
RECOVERY_CHANGE_SET_NAME=recovery-cloud-formation-testing-dev-953136a4def02e9618b99225510be8dcf483e622
DATA_ACTION=RECOVERY_REQUIRED
DATA_REASON="stack missing; change-set=${RECOVERY_CHANGE_SET_NAME}"
write_sourcable_env "$CREATE_ENV" \
  DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT
# shellcheck disable=SC1091
source "$SCRIPT_DIR/promote-exported-variables.sh" \
  "$CREATE_ENV" \
  DATA_ACTION RECOVERY_REQUIRED CURRENT_COMMIT \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE DATA_REASON \
  RECOVERY_CHANGE_SET_NAME
assert_eq "promote recovery exports change set" "${RECOVERY_CHANGE_SET_NAME}" \
  recovery-cloud-formation-testing-dev-953136a4def02e9618b99225510be8dcf483e622

echo "=== promote recovery missing change set fails ==="
RECOVERY_REQUIRED=true
RECOVERY_CHANGE_SET_NAME=""
DATA_ACTION=RECOVERY_REQUIRED
DATA_REASON=recovery
write_sourcable_env "$CREATE_ENV" \
  DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT
assert_fail "promote recovery without change set" bash -c "
  source '$SCRIPT_DIR/promote-exported-variables.sh' '$CREATE_ENV' \
    DATA_ACTION RECOVERY_REQUIRED CURRENT_COMMIT \
    RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE DATA_REASON \
    RECOVERY_CHANGE_SET_NAME
"

echo "=== DataPreflightArtifact staging ==="
DATA_ACTION=CREATE
DATA_REASON=CREATE
RECOVERY_REQUIRED=false
RECOVERY_CHANGE_SET_NAME=""
write_sourcable_env "$CREATE_ENV" \
  DATA_ACTION DATA_REASON RECOVERY_REQUIRED RECOVERY_CHANGE_SET_NAME \
  RECOVERY_STACK_NAME RECOVERY_TABLE_NAME RECOVERY_STAGE CURRENT_COMMIT
"$SCRIPT_DIR/stage-data-preflight-artifact.sh"
test -s "${CODEBUILD_SRC_DIR}/pipeline-data-preflight/data-preflight-artifact.txt"
test -f "${CODEBUILD_SRC_DIR}/pipeline-data-preflight/data-deployment-variables.env"
test ! -d "${CODEBUILD_SRC_DIR}/.pipeline-data-preflight"
assert_eq "artifact dir is non-hidden" \
  "$(test -d "${CODEBUILD_SRC_DIR}/pipeline-data-preflight" && echo yes)" yes

echo "=== packaged.yaml identity ==="
PACKAGED="${SCRIPT_DIR}/../../../workflow/data/packaged.yaml"
if [ -f "$PACKAGED" ]; then
  apply_data_resource_identity_from_template "$PACKAGED"
  assert_eq "artifact TableName" "$DATA_TABLE_NAME" nvdev-use1-mvx-workflow-service-db
  assert_eq "artifact logical ID" "$DATA_LOGICAL_ID" WorkflowTable
  assert_eq "artifact Service tag" "$OWNERSHIP_TAG_SERVICE" workflow-service
  assert_eq "artifact Stage tag" "$OWNERSHIP_TAG_STAGE" dev
  assert_eq "artifact Purpose tag" "$OWNERSHIP_TAG_PURPOSE" WorkflowTable
  assert_eq "artifact ManagedBy tag" "$OWNERSHIP_TAG_MANAGED_BY" serverless
else
  echo "WARN: workflow/data/packaged.yaml not found; skipping identity assertions"
fi

echo
echo "Passed: $PASSES  Failed: $FAILS"
if [ "$FAILS" -ne 0 ]; then
  exit 1
fi
echo "Data deployment contract tests passed."
rm -rf "$CODEBUILD_SRC_DIR"
