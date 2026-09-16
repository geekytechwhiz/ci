#!/bin/bash
# Local contract tests for Validate-SSM.
# Does not call AWS. Run from repo: cicd/pipeline/scripts/test-validate-ssm.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../../cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml"
FAILS=0
PASSES=0
WORKDIR="$(mktemp -d /tmp/validate-ssm-test.XXXXXX)"
STUB_BIN="${WORKDIR}/bin"
mkdir -p "$STUB_BIN"
export PATH="${STUB_BIN}:$PATH"

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
  if "$@" >"${WORKDIR}/ok.out" 2>"${WORKDIR}/ok.err"; then
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: $label (expected success)"
    cat "${WORKDIR}/ok.out" "${WORKDIR}/ok.err" || true
    FAILS=$((FAILS + 1))
  fi
}

assert_fail() {
  local label="$1"
  shift
  if "$@" >"${WORKDIR}/fail.out" 2>"${WORKDIR}/fail.err"; then
    echo "FAIL: $label (expected failure)"
    cat "${WORKDIR}/fail.out" "${WORKDIR}/fail.err" || true
    FAILS=$((FAILS + 1))
  else
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  fi
}

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq "$needle" "$file"; then
    echo "PASS: $label"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL: $label (missing '$needle')"
    FAILS=$((FAILS + 1))
  fi
}

write_aws_stub() {
  local mode="$1"
  cat >"${STUB_BIN}/aws" <<EOF
#!/bin/bash
set -euo pipefail
MODE="${mode}"
STORE="${WORKDIR}/params.env"
REGION=""
NAME=""
args=("\$@")
i=0
while [ \$i -lt \${#args[@]} ]; do
  case "\${args[\$i]}" in
    --region) i=\$((i+1)); REGION="\${args[\$i]}" ;;
    --name) i=\$((i+1)); NAME="\${args[\$i]}" ;;
  esac
  i=\$((i+1))
done

if [ "\${1:-}" = "sts" ]; then
  echo "123456789012	arn:aws:iam::123456789012:user/validate-ssm-test"
  exit 0
fi

if [ "\$MODE" = "denied" ]; then
  echo "An error occurred (AccessDeniedException) when calling the GetParameter operation: User is not authorized to perform: ssm:GetParameter on resource: \$NAME" >&2
  exit 254
fi

if [ "\$MODE" = "wrong-region" ] && [ "\$REGION" != "us-east-1" ]; then
  echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: Region=\$REGION" >&2
  exit 254
fi

if [ ! -f "\$STORE" ]; then
  echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: \$NAME" >&2
  exit 254
fi

# shellcheck disable=SC1090
source "\$STORE"
key=\$(printf '%s' "\$NAME" | tr '/-' '_' | tr -c 'A-Za-z0-9_' '_')
eval "value=\\"\\\${PARAM_\${key}-__MISSING__}\\""
if [ "\$value" = "__MISSING__" ]; then
  echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: \$NAME" >&2
  exit 254
fi
printf '%s' "\$value"
exit 0
EOF
  chmod +x "${STUB_BIN}/aws"
}

set_param() {
  local name="$1" value="$2"
  local key
  key="$(printf '%s' "$name" | tr '/-' '_' | tr -c 'A-Za-z0-9_' '_')"
  echo "PARAM_${key}=$(printf '%q' "$value")" >>"${WORKDIR}/params.env"
}

run_validate() {
  "$SCRIPT_DIR/validate-ssm.sh"
}

reset_env() {
  export SERVICE_NAME=cloud-formation-testing
  export STAGE=dev
  export AWS_REGION=us-east-1
  export ENABLE_SSM_VALIDATION=true
  export SSM_PREFIX=/nvdev-use1-mvx/workflow-service
  export REQUIRED_SSM_PARAMETERS=TABLE_NAME,TABLE_ARN,STREAM_ARN
  unset DATA_TABLE_NAME || true
  unset SSM_EXPECTED_VALUES_FILE || true
  : >"${WORKDIR}/params.env"
  write_aws_stub present
}

echo "=== Template contract ==="
assert_file_contains "Validate-SSM uses bash shell" "$TEMPLATE" $'ValidateSsmProject:\n'
python3 - "$TEMPLATE" <<'PY'
import pathlib, sys, re
text = pathlib.Path(sys.argv[1]).read_text()
start = text.index("  ValidateSsmProject:")
end = text.index("  RecordDeploymentProject:")
block = text[start:end]
checks = [
    ("env.shell bash", "shell: bash" in block),
    ("no !Sub BuildSpec", "BuildSpec: |" in block and "BuildSpec: !Sub" not in block),
    ("repository framework", "bootstrap-framework.sh" in block),
    ("no S3 latest fallback", "S3 latest fallback is disabled" in block),
    ("ENABLE_SSM_VALIDATION env", "Name: ENABLE_SSM_VALIDATION" in block),
    ("IAM uses SsmPrefix only", "parameter/${Stage}/${ServiceName}/*" not in text[text.index("  ValidateSsmRole:"):text.index("  RecordDeploymentRole:")]),
]
failed = 0
for label, ok in checks:
    print(("PASS: " if ok else "FAIL: ") + "template " + label)
    if not ok:
        failed = 1
sys.exit(failed)
PY
if [ $? -eq 0 ]; then
  PASSES=$((PASSES + 6))
else
  FAILS=$((FAILS + 1))
fi

if grep -A2 "Name: Validate-SSM" -n "$TEMPLATE" >/dev/null; then
  python3 - "$TEMPLATE" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
start = text.index("        - Name: Validate-SSM")
end = text.index("        - Name: Deploy-App")
block = text[start:end]
checks = [
    ("SourceArtifact input", "Name: SourceArtifact" in block),
    ("no BuildArtifact input", "BuildArtifact" not in block),
    ("SSM_PREFIX from pipeline variable", "#{variables.SsmPrefix}" in block),
    ("REQUIRED_SSM_PARAMETERS not duplicated on action", "REQUIRED_SSM_PARAMETERS" not in block),
]
failed = 0
for label, ok in checks:
    print(("PASS: " if ok else "FAIL: ") + "pipeline " + label)
    if not ok:
        failed = 1
sys.exit(failed)
PY
  if [ $? -eq 0 ]; then
    PASSES=$((PASSES + 4))
  else
    FAILS=$((FAILS + 1))
  fi
fi

echo "=== Test 1 valid configuration ==="
reset_env
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN arn:aws:dynamodb:us-east-1:123:table/nvdev-use1-mvx-workflow-service-db/stream/1
assert_ok "valid parameters pass" run_validate
assert_file_contains "valid output prefix" "${WORKDIR}/ok.out" "[SSM] Prefix: /nvdev-use1-mvx/workflow-service"
assert_file_contains "valid output passed" "${WORKDIR}/ok.out" "[SSM] Validation PASSED"

echo "=== Test 2 missing parameter ==="
reset_env
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
assert_fail "missing STREAM_ARN fails" run_validate
assert_file_contains "missing names the parameter" "${WORKDIR}/fail.err" "/nvdev-use1-mvx/workflow-service/STREAM_ARN"

echo "=== Test 3 empty parameter value ==="
reset_env
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN ""
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
assert_fail "empty value fails" run_validate
assert_file_contains "empty value reason" "${WORKDIR}/fail.err" "parameter exists but value is empty"

echo "=== Test 4 wrong SSM prefix ==="
reset_env
export SSM_PREFIX=/nvdev-use1-mvx/cloud-formation-testing
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
assert_fail "wrong prefix fails" run_validate
assert_file_contains "wrong prefix in error" "${WORKDIR}/fail.err" "/nvdev-use1-mvx/cloud-formation-testing/TABLE_NAME"

echo "=== Test 5 IAM denied ==="
reset_env
write_aws_stub denied
assert_fail "access denied fails" run_validate
assert_file_contains "access denied reason" "${WORKDIR}/fail.err" "AccessDenied"

echo "=== Test 6 empty RequiredSsmParameters ==="
reset_env
export REQUIRED_SSM_PARAMETERS=""
assert_fail "empty required list fails when enabled" run_validate
reset_env
export ENABLE_SSM_VALIDATION=false
export REQUIRED_SSM_PARAMETERS=""
assert_ok "empty required list skipped when disabled" run_validate
assert_file_contains "skip message" "${WORKDIR}/ok.out" "validation skipped intentionally"

echo "=== Test 7 whitespace ==="
reset_env
export REQUIRED_SSM_PARAMETERS="TABLE_NAME, TABLE_ARN , STREAM_ARN"
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
assert_ok "whitespace around leaves is trimmed" run_validate

echo "=== Test 8 duplicate parameter ==="
reset_env
export REQUIRED_SSM_PARAMETERS="TABLE_NAME,TABLE_ARN,TABLE_NAME"
assert_fail "duplicates are rejected" run_validate
assert_file_contains "duplicate leaf named" "${WORKDIR}/fail.err" "duplicate parameter leaf: TABLE_NAME"

echo "=== Test 9 malformed parameter path ==="
reset_env
export REQUIRED_SSM_PARAMETERS="/nvdev-use1-mvx/workflow-service/TABLE_NAME"
assert_fail "full path is rejected before AWS" run_validate
assert_file_contains "malformed full path" "${WORKDIR}/fail.err" "malformed parameter path"
reset_env
export REQUIRED_SSM_PARAMETERS="TABLE_NAME,foo/bar"
assert_fail "slash in leaf is rejected before AWS" run_validate
reset_env
export SSM_PREFIX=nvdev-use1-mvx/workflow-service
assert_fail "prefix without leading slash fails before AWS" run_validate

echo "=== Test 10 wrong region ==="
reset_env
write_aws_stub wrong-region
export AWS_REGION=us-west-2
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
assert_fail "wrong region fails" run_validate
assert_file_contains "region in error" "${WORKDIR}/fail.err" "Region: us-west-2"

echo "=== Expected value contract ==="
reset_env
export DATA_TABLE_NAME=nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME other-table
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
assert_fail "TABLE_NAME mismatch against DATA_TABLE_NAME" run_validate

echo "=== CREATE / UPDATE / recovery / retry ==="
reset_env
set_param /nvdev-use1-mvx/workflow-service/TABLE_NAME nvdev-use1-mvx-workflow-service-db
set_param /nvdev-use1-mvx/workflow-service/TABLE_ARN arn:aws:dynamodb:us-east-1:123:table/x
set_param /nvdev-use1-mvx/workflow-service/STREAM_ARN stream
export DATA_ACTION=CREATE
assert_ok "CREATE path only needs SSM contract" run_validate
export DATA_ACTION=UPDATE
assert_ok "UPDATE path only needs SSM contract" run_validate
export DATA_ACTION=RECOVERY_REQUIRED
assert_ok "recovery retry only needs SSM contract" run_validate

echo
echo "Passed: $PASSES  Failed: $FAILS"
rm -rf "$WORKDIR"
if [ "$FAILS" -ne 0 ]; then
  exit 1
fi
echo "Validate-SSM contract tests passed."
