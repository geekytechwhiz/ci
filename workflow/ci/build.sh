#!/bin/bash
# PACKAGE ONLY. Writes:
#   workflow/data/packaged.yaml
#   workflow/infrastructure/packaged.yaml
#   workflow/packaged.yaml
#   workflow/deployment-manifest.json (when CURRENT_COMMIT is set)
# Does not upload CI/CD artifacts (cicd/pipeline/scripts/publish-artifacts.sh does that to ARTIFACT_BUCKET).
# Does not deploy CloudFormation, validate SSM, or run smoke tests.
# CodePipeline stages Deploy-Data / Deploy-Infra / Validate-SSM / Deploy-App / Smoke-Test
# own those steps.

set -euo pipefail

echo "======================================="
echo "BUILD STARTED (package only)"
echo "======================================="

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${CICD_SCRIPTS_DIR:-}" ] && [ -f "${CICD_SCRIPTS_DIR}/common.sh" ]; then
  # shellcheck source=/dev/null
  source "${CICD_SCRIPTS_DIR}/common.sh"
elif [ -f "$SCRIPT_DIR/../../cicd/pipeline/scripts/common.sh" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/../../cicd/pipeline/scripts/common.sh"
else
  echo "ERROR: Cannot find generic common.sh" >&2
  exit 1
fi

assert_stage
assert_codebuild_stage_match

# common.sh falls back to CODEBUILD_SRC_DIR (repo root) when SERVICE_DIR is unset.
# This service lives in workflow/; data/, infrastructure/, and serverless.yml are
# there — not at the repository root. Resolve from this script (workflow/ci).
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_ROOT="$SERVICE_DIR"
export SERVICE_DIR SERVICE_ROOT

cd "$SERVICE_DIR"

echo "Current Directory:"
pwd
if [ ! -d data ] || [ ! -d infrastructure ] || [ ! -f serverless.yml ]; then
  echo "ERROR: SERVICE_DIR=$SERVICE_DIR is not the workflow service root (need data/, infrastructure/, serverless.yml)" >&2
  exit 1
fi
echo "STAGE=$STAGE ARTIFACT_BUCKET=$ARTIFACT_BUCKET AWS_REGION=$AWS_REGION STACK_NAME=${STACK_NAME:-$APP_STACK_NAME} DATA_STACK_NAME=$DATA_STACK_NAME INFRA_STACK_NAME=$INFRA_STACK_NAME"

echo "Cleaning old artifacts..."
rm -rf .serverless
rm -f packaged.yaml
rm -rf data/.serverless
rm -f data/packaged.yaml
rm -rf infrastructure/.serverless
rm -f infrastructure/packaged.yaml

# Serverless may add an internal deployment-bucket export. Remove all
# Outputs so the POC contract stays SSM-only (no CloudFormation exports).
strip_cfn_outputs() {
  local path="$1"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const tpl = JSON.parse(fs.readFileSync(p, "utf8"));
    delete tpl.Outputs;
    fs.writeFileSync(p, JSON.stringify(tpl, null, 2) + "\n");
  ' "$path"
}

copy_packaged_template() {
  local source_dir="$1"
  local dest="$2"
  local template=""
  if [ -f "$source_dir/cloudformation-template-update-stack.json" ]; then
    template="$source_dir/cloudformation-template-update-stack.json"
  elif [ -f "$source_dir/cloudformation-template-create-stack.json" ]; then
    template="$source_dir/cloudformation-template-create-stack.json"
  else
    echo "ERROR: No CloudFormation template generated in $source_dir"
    ls -la "$source_dir" || true
    exit 1
  fi
  cp "$template" "$dest"
  strip_cfn_outputs "$dest"
  echo "Packaged template: $dest"
}

# SMALL CodeBuild (~3.6 GiB): cap Node heap so the esbuild subprocess has headroom.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

if command -v free >/dev/null 2>&1; then
  echo "Container memory:"
  free -h || true
fi

# Pipeline Build (generic-codepipeline.yml) does not run npm install. Plugins such
# as serverless-esbuild live in workflow/package.json devDependencies. Using
# `npx --package serverless` only installs the CLI, which produces:
#   Serverless plugin "serverless-esbuild" not found
SERVERLESS_VERSION="${SERVERLESS_VERSION:-3.40.0}"
SERVERLESS_BIN="$SERVICE_DIR/node_modules/.bin/serverless"

install_workflow_npm_deps() {
  echo "Installing workflow npm dependencies from $SERVICE_DIR ..."
  # npm omits devDependencies when NODE_ENV=production or npm_config_production=true.
  local saved_node_env="${NODE_ENV-}"
  local saved_npm_production="${npm_config_production-}"
  unset NODE_ENV || true
  unset npm_config_production || true
  export NPM_CONFIG_PRODUCTION=false

  if [ -f package-lock.json ]; then
    npm ci --include=dev --legacy-peer-deps
  else
    npm install --include=dev --legacy-peer-deps
  fi

  unset NPM_CONFIG_PRODUCTION || true
  if [ -n "$saved_node_env" ]; then
    export NODE_ENV="$saved_node_env"
  fi
  if [ -n "$saved_npm_production" ]; then
    export npm_config_production="$saved_npm_production"
  fi
}

assert_serverless_plugins() {
  local plugin missing=0
  for plugin in serverless-esbuild serverless-dotenv-plugin serverless-auto-swagger @myvitalrx/mvrx-resource-registry; do
    if ! PLUGIN="$plugin" node -e "require.resolve(process.env.PLUGIN)"; then
      echo "ERROR: Serverless plugin not installed: $plugin" >&2
      missing=1
    else
      echo "Plugin OK: $plugin"
    fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "ERROR: Install dependencies in workflow/ so serverless.yml plugins resolve from node_modules." >&2
    exit 1
  fi
}

if [ -n "${CODEBUILD_BUILD_ID:-}" ] || [ ! -x "$SERVERLESS_BIN" ] || [ ! -d "$SERVICE_DIR/node_modules/serverless-esbuild" ]; then
  install_workflow_npm_deps
else
  echo "Using existing node_modules (serverless-esbuild already present)"
fi

if [ ! -x "$SERVERLESS_BIN" ]; then
  echo "ERROR: serverless CLI missing at $SERVERLESS_BIN after npm install." >&2
  echo "ERROR: Do not fall back to npx serverless — that CLI cannot load workflow plugins." >&2
  exit 1
fi

assert_serverless_plugins

run_serverless() {
  "$SERVERLESS_BIN" "$@"
}

echo "Resolving Serverless Framework CLI (required 3.x, pin ${SERVERLESS_VERSION})..."
echo "Using local CLI: $SERVERLESS_BIN"
SLS_VERSION_OUT="$(run_serverless --version)"
echo "$SLS_VERSION_OUT"
if ! echo "$SLS_VERSION_OUT" | grep -qE 'Framework Core: 3\.'; then
  echo "ERROR: Workflow packaging requires Serverless Framework 3.x (got incompatible CLI)." >&2
  echo "ERROR: Unpinned npx serverless resolves to 4.x, which cannot satisfy frameworkVersion: '3.x'." >&2
  exit 1
fi

echo "Packaging data stack ($DATA_STACK_NAME)..."
(
  cd data
  run_serverless package \
    --config serverless.data.yml \
    --stage "$STAGE" \
    --package .serverless
)
copy_packaged_template data/.serverless data/packaged.yaml

echo "Packaging infrastructure stack ($INFRA_STACK_NAME)..."
(
  cd infrastructure
  run_serverless package \
    --config serverless.infra.yml \
    --stage "$STAGE" \
    --package .serverless
)
copy_packaged_template infrastructure/.serverless infrastructure/packaged.yaml

echo "Packaging application stack ($APP_STACK_NAME) (NODE_OPTIONS=$NODE_OPTIONS)..."
run_serverless package \
  --stage "$STAGE" \
  --package .serverless

echo "Finding generated application CloudFormation template..."

if [ -f ".serverless/cloudformation-template-update-stack.json" ]; then
  TEMPLATE=".serverless/cloudformation-template-update-stack.json"
elif [ -f ".serverless/cloudformation-template-create-stack.json" ]; then
  TEMPLATE=".serverless/cloudformation-template-create-stack.json"
else
  echo "ERROR: No application CloudFormation template generated"
  ls -la .serverless || true
  exit 1
fi

echo "Using application template: $TEMPLATE"

# `serverless package` writes S3Bucket/S3Key into the CF template but does not
# upload zips. CI/CD artifacts (templates + Lambda zips) are published by
# ci/publish-artifacts.sh to s3://${ARTIFACT_BUCKET}/workflow-service/${CURRENT_COMMIT}/.
# Serverless provider.deploymentBucket remains packaging-internal only.
cp "$TEMPLATE" packaged.yaml

echo "Extracting Lambda S3 keys from the packaged application template..."
node <<'NODE' > .serverless/s3keys.txt
const fs = require('fs');
const raw = fs.readFileSync('.serverless/' + (
  fs.existsSync('.serverless/cloudformation-template-update-stack.json')
    ? 'cloudformation-template-update-stack.json'
    : 'cloudformation-template-create-stack.json'
), 'utf8');
const tpl = JSON.parse(raw);
const keys = new Set();

for (const res of Object.values(tpl.Resources || {})) {
  const code = res.Properties && res.Properties.Code;
  if (code && code.S3Key) keys.add(code.S3Key);
}

for (const key of [...keys].sort()) console.log(key);
NODE

if [ ! -s .serverless/s3keys.txt ]; then
  echo "WARN: No S3Key entries found in CF template — Serverless may have used inline ZipFile or a different layout."
  echo "Listing .serverless contents for diagnosis:"
  ls -la .serverless/
else
  echo "Lambda zip keys (local .serverless artifacts; published later to ARTIFACT_BUCKET):"
  cat .serverless/s3keys.txt
  while read -r key; do
    [ -z "$key" ] && continue
    zip_name=$(basename "${key%%@*}")
    local_path=".serverless/$zip_name"
    if [ ! -f "$local_path" ]; then
      echo "ERROR: Local artifact not found: $local_path (key: $key)"
      exit 1
    fi
  done < .serverless/s3keys.txt
fi

echo "Packaged templates created under $SERVICE_DIR:"
ls -la "$SERVICE_DIR/data/packaged.yaml" \
  "$SERVICE_DIR/infrastructure/packaged.yaml" \
  "$SERVICE_DIR/packaged.yaml"

# Change detection decides DEPLOY_*; Build owns the commit-scoped manifest.
# CURRENT_COMMIT is resolved before this script in the Build stage.
if [ -n "${CURRENT_COMMIT:-}" ]; then
  echo "Generating deployment-manifest.json for $CURRENT_COMMIT..."
  generate_deployment_manifest
  echo "Local deployment manifest:"
  ls -la "$(resolve_deployment_manifest_dest)"
else
  echo "CURRENT_COMMIT is unset — skipping deployment-manifest.json (local package only)."
fi

echo "======================================="
echo "BUILD COMPLETED"
echo "======================================="
