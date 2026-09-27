#!/bin/bash
# Artifact discovery and path contract tests. Does not call AWS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILS=0
PASSES=0
WORKDIR="$(mktemp -d /tmp/artifact-contract.XXXXXX)"

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
    echo "FAIL: $label"
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

export SERVICE_NAME=example-pipeline
export STAGE=dev
export AWS_REGION=us-east-1
export RESOURCE_NAME_PREFIX=nvdev-use1-mvx
export SSM_PREFIX=/nvdev-use1-mvx/example-service
export CURRENT_COMMIT=953136a4def02e9618b99225510be8dcf483e622
export ARTIFACT_BUCKET=example-artifact-bucket
export CODEBUILD_SRC_DIR="$WORKDIR"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

assert_eq "artifact prefix uses pipeline SERVICE_NAME" \
  "$(environment_artifact_prefix "$CURRENT_COMMIT")" \
  "example-pipeline/${CURRENT_COMMIT}"
assert_eq "artifact prefix is not application SSM leaf" \
  "$(environment_artifact_prefix "$CURRENT_COMMIT")" \
  "example-pipeline/${CURRENT_COMMIT}"

APP_DIR="${WORKDIR}/app"
mkdir -p "${WORKDIR}/.serverless" "$APP_DIR"
cat >"${WORKDIR}/app-template.json" <<'EOF'
{
  "Resources": {
    "ApiLambdaFunction": {
      "Type": "AWS::Lambda::Function",
      "Properties": {
        "Code": { "S3Bucket": "old-bucket", "S3Key": "serverless/api.zip" }
      }
    },
    "EventsLambdaFunction": {
      "Type": "AWS::Lambda::Function",
      "Properties": {
        "Code": { "S3Bucket": "old-bucket", "S3Key": "serverless/events.zip" }
      }
    }
  }
}
EOF
: > "${WORKDIR}/.serverless/api.zip"
: > "${WORKDIR}/.serverless/events.zip"
printf 'x' > "${WORKDIR}/.serverless/api.zip"
printf 'y' > "${WORKDIR}/.serverless/events.zip"

SEARCH_DIRS="${WORKDIR}/.serverless" assert_ok "discover finds both Lambda ZIPs" \
  node "$SCRIPT_DIR/discover-lambda-artifacts.cjs" "${WORKDIR}/app-template.json" --require-zips
assert_eq "discovery mentions api.zip" \
  "$(grep -c '"zipName": "api.zip"' "${WORKDIR}/ok.out" || true)" 1
assert_eq "discovery mentions events.zip" \
  "$(grep -c '"zipName": "events.zip"' "${WORKDIR}/ok.out" || true)" 1

SEARCH_DIRS="${WORKDIR}/missing" assert_fail "discover fails when ZIPs are missing" \
  node "$SCRIPT_DIR/discover-lambda-artifacts.cjs" "${WORKDIR}/app-template.json" --require-zips

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
assert_file_contains "discovery does not mention s3keys.txt" "$SCRIPT_DIR/discover-lambda-artifacts.cjs" "Does not read .serverless/s3keys.txt"
assert_file_contains "publish does not require s3keys.txt" "$SCRIPT_DIR/publish-artifacts.sh" "discover_lambda_artifacts_json"

# Local verify-artifacts fails closed when templates are missing.
VERIFY_DIR="${WORKDIR}/service"
mkdir -p "$VERIFY_DIR"
export SERVICE_DIR="$VERIFY_DIR"
export SERVICE_ROOT="$VERIFY_DIR"
export ENABLE_DATA=true ENABLE_INFRA=true ENABLE_APP=true
export DEPLOY_DATA=true DEPLOY_INFRA=true DEPLOY_APP=true
assert_fail "missing data artifact fails verify" "$SCRIPT_DIR/verify-artifacts.sh"
assert_file_contains "missing data message" "${WORKDIR}/fail.err" "data/packaged.yaml not found"

mkdir -p "$VERIFY_DIR/data" "$VERIFY_DIR/infra" "$VERIFY_DIR/app"
echo '{}' > "$VERIFY_DIR/data/packaged.yaml"
echo '{}' > "$VERIFY_DIR/infra/packaged.yaml"
assert_fail "missing app template fails verify" "$SCRIPT_DIR/verify-artifacts.sh"
assert_file_contains "missing app message" "${WORKDIR}/fail.err" "app/packaged.yaml not found"

echo
echo "Passed: $PASSES  Failed: $FAILS"
rm -rf "$WORKDIR"
if [ "$FAILS" -ne 0 ]; then
  exit 1
fi
echo "Artifact contract tests passed."
