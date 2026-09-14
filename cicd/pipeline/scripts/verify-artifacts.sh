#!/bin/bash
# Verify packaged templates and published immutable S3 artifacts.
# Service-agnostic: no hard-coded authorizer or service checks.

set -euo pipefail

echo "======================================="
echo "VERIFYING DEPLOYMENT ARTIFACTS"
echo "======================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
assert_stage

DEPLOY_DATA="$(normalize_bool "${DEPLOY_DATA:-false}")"
DEPLOY_INFRA="$(normalize_bool "${DEPLOY_INFRA:-false}")"
DEPLOY_APP="$(normalize_bool "${DEPLOY_APP:-false}")"
ENABLE_DATA="$(normalize_bool "${ENABLE_DATA:-true}")"
ENABLE_INFRA="$(normalize_bool "${ENABLE_INFRA:-true}")"
ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"

cd "$SERVICE_DIR"

TEMPLATE="${PACKAGED_TEMPLATE:-packaged.yaml}"
DATA_TEMPLATE="${DATA_PACKAGED_TEMPLATE:-data/packaged.yaml}"
INFRA_TEMPLATE="${INFRA_PACKAGED_TEMPLATE:-infrastructure/packaged.yaml}"

need_data=false
need_infra=false
need_app=false
[ "$ENABLE_DATA" = "true" ] && [ "$DEPLOY_DATA" = "true" ] && need_data=true
[ "$ENABLE_INFRA" = "true" ] && [ "$DEPLOY_INFRA" = "true" ] && need_infra=true
[ "$ENABLE_APP" = "true" ] && [ "$DEPLOY_APP" = "true" ] && need_app=true

if [ "$need_data" = false ] && [ "$need_infra" = false ] && [ "$need_app" = false ]; then
  [ "$ENABLE_DATA" = "true" ] && [ -f "$DATA_TEMPLATE" ] && need_data=true
  [ "$ENABLE_INFRA" = "true" ] && [ -f "$INFRA_TEMPLATE" ] && need_infra=true
  [ "$ENABLE_APP" = "true" ] && [ -f "$TEMPLATE" ] && need_app=true
fi

if [ "$need_app" = true ] && [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: packaged.yaml not found (application artifact)"
  exit 1
fi
if [ "$need_data" = true ] && [ ! -f "$DATA_TEMPLATE" ]; then
  echo "ERROR: data/packaged.yaml not found (data artifact)"
  exit 1
fi
if [ "$need_infra" = true ] && [ ! -f "$INFRA_TEMPLATE" ]; then
  echo "ERROR: infrastructure/packaged.yaml not found (infrastructure artifact)"
  exit 1
fi

echo "Verify layers: data=$need_data infra=$need_infra app=$need_app"

BUCKET="$(environment_artifact_bucket)"
echo "Using ARTIFACT_BUCKET: $BUCKET"

if [ "$need_app" = true ]; then
  echo "Extracting S3 keys from application template..."
  TEMPLATE_FILE="$TEMPLATE" node <<'NODE' > /tmp/s3keys.txt
const fs = require('fs');
const template = fs.readFileSync(process.env.TEMPLATE_FILE, 'utf8');
const keys = new Set();
const lines = template.split(/\r?\n/);
for (const line of lines) {
  let m = line.match(/^\s*S3Key\s*:\s*(['"])(.+)\1\s*(?:#.*)?$/);
  if (m) { const v = m[2].trim(); if (v) keys.add(v); continue; }
  m = line.match(/^\s*S3Key\s*:\s*([^#]+)\s*(?:#.*)?$/);
  if (m) { const v = m[1].trim(); if (v) keys.add(v); continue; }
  m = line.match(/"S3Key"\s*:\s*(['"])(.+?)\1\s*(?:,)?\s*$/);
  if (m) { const v = m[2].trim(); if (v) keys.add(v); continue; }
}
for (const key of [...keys].sort()) console.log(key);
NODE

  if [ -s /tmp/s3keys.txt ]; then
    echo "Checking uploaded Lambda artifacts in s3://${BUCKET} ..."
    missing=0
    while read -r key; do
      [ -z "$key" ] && continue
      printf "Checking %-80s" "$key"
      if aws s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
        echo "FOUND"
      else
        echo "MISSING"
        missing=1
      fi
    done < /tmp/s3keys.txt
    if [ "$missing" -ne 0 ]; then
      echo "ERROR: One or more Lambda artifacts are missing"
      exit 1
    fi
  else
    echo "WARN: No S3Key entries found in application packaged.yaml"
  fi
fi

if [ -n "${CURRENT_COMMIT:-}" ]; then
  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    echo "ERROR: CURRENT_COMMIT must be a Git commit SHA to verify published artifacts"
    exit 1
  fi
  ARTIFACT_PREFIX="$(environment_artifact_prefix "$CURRENT_COMMIT")"
  echo "Verifying immutable artifacts under s3://${BUCKET}/${ARTIFACT_PREFIX}/ ..."
  published_missing=0
  check_key() {
    local key="$1"
    printf "Checking %-80s" "$key"
    if aws s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
      echo "FOUND"
    else
      echo "MISSING"
      published_missing=1
    fi
  }
  [ "$need_data" = true ] && check_key "${ARTIFACT_PREFIX}/data/packaged.yaml"
  [ "$need_infra" = true ] && check_key "${ARTIFACT_PREFIX}/infra/packaged.yaml"
  [ "$need_app" = true ] && check_key "${ARTIFACT_PREFIX}/app/packaged.yaml"
  check_key "${ARTIFACT_PREFIX}/deployment-manifest.json"
  if [ "$published_missing" -ne 0 ]; then
    echo "ERROR: One or more commit-scoped environment artifacts are missing"
    exit 1
  fi
fi

echo "======================================="
echo "ALL ARTIFACTS VERIFIED"
echo "======================================="
