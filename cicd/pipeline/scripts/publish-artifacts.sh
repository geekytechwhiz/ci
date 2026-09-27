#!/bin/bash
# Publish immutable, commit-scoped artifacts after package + manifest generation.
# Layout:
#   s3://$ARTIFACT_BUCKET/${SERVICE_NAME}/<commit-sha>/{data,infra,app}/packaged.yaml
#   s3://$ARTIFACT_BUCKET/${SERVICE_NAME}/<commit-sha>/app/<lambda>.zip
#   s3://$ARTIFACT_BUCKET/${SERVICE_NAME}/<commit-sha>/deployment-manifest.json
#
# App publish is atomic:
#   discover ZIPs from packaged.yaml + Serverless output
#     → validate local ZIPs
#     → upload ZIPs
#     → verify ZIP uploads
#     → rewrite app/packaged.yaml to those keys
#     → upload packaged.yaml
#
# Only publishes layers that are enabled and selected for deploy (DEPLOY_*=true).
# Refuses overwrite of existing keys unless the object SHA-256 matches.

set -euo pipefail

echo "======================================="
echo "PUBLISH ENVIRONMENT ARTIFACTS"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
: "${CURRENT_COMMIT:?CURRENT_COMMIT must be set to a Git commit SHA}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

assert_stage

DEPLOY_DATA="$(normalize_bool "${DEPLOY_DATA:-false}")"
DEPLOY_INFRA="$(normalize_bool "${DEPLOY_INFRA:-false}")"
DEPLOY_APP="$(normalize_bool "${DEPLOY_APP:-false}")"
ENABLE_DATA="$(normalize_bool "${ENABLE_DATA:-true}")"
ENABLE_INFRA="$(normalize_bool "${ENABLE_INFRA:-true}")"
ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"

if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
  echo "ERROR: CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path."
  echo "CURRENT_COMMIT=$CURRENT_COMMIT"
  exit 1
fi

resolve_local_manifest() {
  local candidate="${DEPLOYMENT_MANIFEST:-deployment-manifest.json}"
  local src_root="${CODEBUILD_SRC_DIR:-}"

  if [ -f "$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  if [ -n "$src_root" ] && [ -f "$src_root/$candidate" ]; then
    printf '%s' "$src_root/$candidate"
    return 0
  fi
  if [ -f "$SERVICE_DIR/deployment-manifest.json" ]; then
    printf '%s' "$SERVICE_DIR/deployment-manifest.json"
    return 0
  fi
  if [ -f "deployment-manifest.json" ]; then
    printf '%s' "deployment-manifest.json"
    return 0
  fi

  echo "ERROR: deployment-manifest.json not found." >&2
  echo "Service build.sh must write this file before publish-artifacts.sh runs." >&2
  return 1
}

echo "Publish working directory SERVICE_DIR=$SERVICE_DIR"
echo "Pipeline identity:     $SERVICE_NAME"
echo "Application identity:  $APPLICATION_SERVICE_NAME"
cd "$SERVICE_DIR"

DATA_TEMPLATE="${DATA_PACKAGED_TEMPLATE:-data/packaged.yaml}"
INFRA_TEMPLATE="${INFRA_PACKAGED_TEMPLATE:-infra/packaged.yaml}"
APP_TEMPLATE="${PACKAGED_TEMPLATE:-app/packaged.yaml}"
MANIFEST="$(resolve_local_manifest)"

need_data=false
need_infra=false
need_app=false
[ "$ENABLE_DATA" = "true" ] && [ "$DEPLOY_DATA" = "true" ] && need_data=true
[ "$ENABLE_INFRA" = "true" ] && [ "$DEPLOY_INFRA" = "true" ] && need_infra=true
[ "$ENABLE_APP" = "true" ] && [ "$DEPLOY_APP" = "true" ] && need_app=true

# If no DEPLOY_* set but something was packaged, publish all present enabled layers
if [ "$need_data" = false ] && [ "$need_infra" = false ] && [ "$need_app" = false ]; then
  [ "$ENABLE_DATA" = "true" ] && [ -f "$DATA_TEMPLATE" ] && need_data=true
  [ "$ENABLE_INFRA" = "true" ] && [ -f "$INFRA_TEMPLATE" ] && need_infra=true
  [ "$ENABLE_APP" = "true" ] && [ -f "$APP_TEMPLATE" ] && need_app=true
fi

if [ "$need_data" = true ] && [ ! -f "$DATA_TEMPLATE" ]; then
  echo "ERROR: Data packaged template missing: $DATA_TEMPLATE"
  echo "ERROR: Looked in SERVICE_DIR=$SERVICE_DIR (pwd=$(pwd))"
  echo "ERROR: Service build.sh writes this file under SERVICE_DIR (next to serverless.yml), not the repo root."
  ls -la data 2>/dev/null || ls -la "$SERVICE_DIR/data" 2>/dev/null || true
  exit 1
fi
if [ "$need_infra" = true ] && [ ! -f "$INFRA_TEMPLATE" ]; then
  echo "ERROR: Infra packaged template missing: $INFRA_TEMPLATE"
  exit 1
fi
if [ "$need_app" = true ] && [ ! -f "$APP_TEMPLATE" ]; then
  echo "ERROR: App packaged template missing: $APP_TEMPLATE"
  exit 1
fi

BUCKET="$(environment_artifact_bucket)"
PREFIX="$(environment_artifact_prefix "$CURRENT_COMMIT")"

echo "Artifact bucket: $BUCKET"
echo "Artifact prefix: $PREFIX"
echo "Current commit:  $CURRENT_COMMIT"
echo "Stage:           $STAGE"
echo "Pipeline service: $SERVICE_NAME"
echo "Application service: $APPLICATION_SERVICE_NAME"
echo "Deployment manifest: $MANIFEST"
echo "Publish layers: data=$need_data infra=$need_infra app=$need_app"

rewrite_app_lambda_artifact_locations() {
  local template="$1"
  local bucket="$2"
  local prefix="$3"
  REWRITE_BUCKET="$bucket" REWRITE_PREFIX="$prefix" node -e '
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const bucket = process.env.REWRITE_BUCKET;
const prefix = process.env.REWRITE_PREFIX;
const raw = fs.readFileSync(file, "utf8");
let tpl;
try {
  tpl = JSON.parse(raw);
} catch (e) {
  console.error("ERROR: App template is not JSON CloudFormation output; cannot rewrite Lambda Code locations");
  process.exit(1);
}
let rewritten = 0;
const resources = tpl.Resources || {};
for (const res of Object.values(resources)) {
  const code = res.Properties && res.Properties.Code;
  if (!code || !code.S3Key) continue;
  const zipName = path.basename(String(code.S3Key).split("@")[0]);
  code.S3Bucket = bucket;
  code.S3Key = `${prefix}/app/${zipName}`;
  delete code.S3ObjectVersion;
  rewritten += 1;
}

// Shared ARTIFACT_BUCKET replaced ServerlessDeploymentBucket. Drop the leftover
// Serverless-generated bucket, policy, and any Output that still Refs it.
// Leaving Outputs.ServerlessDeploymentBucketName after removing the resource
// is exactly: "Unresolved resource dependencies [ServerlessDeploymentBucket]
// in the Outputs block of the template".
if (tpl.Resources) {
  delete tpl.Resources.ServerlessDeploymentBucket;
  delete tpl.Resources.ServerlessDeploymentBucketPolicy;
}
if (tpl.Outputs) {
  for (const [key, out] of Object.entries(tpl.Outputs)) {
    if (key === "ServerlessDeploymentBucketName" ||
        JSON.stringify(out).includes("ServerlessDeploymentBucket")) {
      delete tpl.Outputs[key];
    }
  }
  if (Object.keys(tpl.Outputs).length === 0) delete tpl.Outputs;
}

const leftover = JSON.stringify(tpl).includes("ServerlessDeploymentBucket");
if (leftover) {
  console.error("ERROR: ServerlessDeploymentBucket still referenced after artifact rewrite");
  process.exit(1);
}

fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + "\n");
console.log(`Rewrote ${rewritten} Lambda Code location(s) to s3://${bucket}/${prefix}/app/`);
console.log("Removed ServerlessDeploymentBucket resource/policy/outputs (shared artifact bucket owns packages)");
' "$template"
}

verify_s3_object() {
  local key="$1"
  if ! aws s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
    echo "ERROR: Uploaded object missing: s3://${BUCKET}/${key}"
    return 1
  fi
  echo "Verified s3://${BUCKET}/${key}"
}

LAMBDA_DISCOVERY=""
if [ "$need_app" = true ]; then
  echo "Discovering Lambda ZIP artifacts from ${APP_TEMPLATE} and Serverless package output..."
  mkdir -p app/.serverless
  SEARCH_DIRS=".serverless:app/.serverless" \
    LAMBDA_DISCOVERY="$(discover_lambda_artifacts_json "$APP_TEMPLATE")"
  printf '%s\n' "$LAMBDA_DISCOVERY" > app/.serverless/lambda-artifacts.json

  ZIP_COUNT="$(DISCOVERY="$LAMBDA_DISCOVERY" node -e 'const d=JSON.parse(process.env.DISCOVERY); process.stdout.write(String((d.artifacts||[]).length))')"
  if [ "$ZIP_COUNT" = "0" ]; then
    echo "ERROR: Application template has no discoverable Lambda ZIP artifacts to publish"
    echo "ERROR: Refusing to upload app/packaged.yaml that would reference missing objects"
    exit 1
  fi

  echo "Validating local Lambda ZIP files..."
  DISCOVERY="$LAMBDA_DISCOVERY" node -e '
    const fs = require("fs");
    const data = JSON.parse(process.env.DISCOVERY);
    let failed = 0;
    for (const art of data.artifacts || []) {
      if (!fs.existsSync(art.localPath)) {
        console.error(`ERROR: Local Lambda artifact not found: ${art.localPath} (${art.logicalId})`);
        failed = 1;
      } else {
        const st = fs.statSync(art.localPath);
        if (!st.size) {
          console.error(`ERROR: Local Lambda artifact is empty: ${art.localPath}`);
          failed = 1;
        }
      }
    }
    process.exit(failed);
  '

  echo "Uploading Lambda ZIP artifacts..."
  while IFS=$'\t' read -r local_path key; do
    [ -z "$local_path" ] && continue
    upload_environment_artifact "$local_path" "$key"
    verify_s3_object "$key"
  done < <(
    DISCOVERY="$LAMBDA_DISCOVERY" PREFIX="$PREFIX" node -e '
      const data = JSON.parse(process.env.DISCOVERY);
      for (const art of data.artifacts || []) {
        console.log(`${art.localPath}\t${process.env.PREFIX}/app/${art.zipName}`);
      }
    '
  )

  echo "Lambda artifacts uploaded:"
  echo "  PASS"

  echo "Rewriting application template to immutable Lambda artifact locations..."
  rewrite_app_lambda_artifact_locations "$APP_TEMPLATE" "$BUCKET" "$PREFIX"
fi

[ "$need_data" = true ] && upload_environment_artifact "$DATA_TEMPLATE" "${PREFIX}/data/packaged.yaml"
[ "$need_infra" = true ] && upload_environment_artifact "$INFRA_TEMPLATE" "${PREFIX}/infra/packaged.yaml"
[ "$need_app" = true ] && upload_environment_artifact "$APP_TEMPLATE" "${PREFIX}/app/packaged.yaml"

upload_environment_artifact "$MANIFEST" "${PREFIX}/deployment-manifest.json"

if [ "$need_app" = true ]; then
  S3KEYS_FILE=""
  for candidate in .serverless/s3keys.txt app/.serverless/s3keys.txt; do
    if [ -f "$candidate" ]; then
      S3KEYS_FILE="$candidate"
      break
    fi
  done
  if [ -n "$S3KEYS_FILE" ]; then
    while read -r key; do
      [ -z "$key" ] && continue
      zip_name="$(basename "${key%%@*}")"
      local_path=""
      for zip_dir in .serverless app/.serverless; do
        if [ -f "$zip_dir/$zip_name" ]; then
          local_path="$zip_dir/$zip_name"
          break
        fi
      done
      if [ -z "$local_path" ]; then
        echo "ERROR: Local Lambda artifact not found: $zip_name (key: $key)"
        exit 1
      fi
      upload_environment_artifact "$local_path" "${PREFIX}/app/${zip_name}"
    done < "$S3KEYS_FILE"
  else
    echo "WARN: s3keys.txt not found under .serverless/ or app/.serverless/ — app zip copies not published"
  fi
fi

echo "Published immutable artifacts under s3://${BUCKET}/${PREFIX}/"
echo "Immutable artifact root: ${PREFIX}"
echo "======================================="
echo "PUBLISH ENVIRONMENT ARTIFACTS COMPLETED"
echo "======================================="
