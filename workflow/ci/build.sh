#!/usr/bin/env bash
# PACKAGE ONLY. Writes:
#   data/packaged.yaml
#   infra/packaged.yaml
#   app/packaged.yaml
# Does not deploy CloudFormation, upload artifacts, validate SSM, or run smoke tests.
# The generic CI/CD pipeline owns deployment after this script succeeds.

set -euo pipefail

echo "======================================="
echo "[BUILD] STARTED (service packaging)"
echo "======================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVICE_DIR"

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION
case "$STAGE" in
  dev|stg|prd) ;;
  *)
    echo "ERROR: STAGE must be dev, stg, or prd (got: ${STAGE})" >&2
    exit 1
    ;;
esac

export CI="${CI:-true}"
export SLS_INTERACTIVE_SETUP_ENABLE="${SLS_INTERACTIVE_SETUP_ENABLE:-0}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

SERVERLESS_VERSION="${SERVERLESS_VERSION:-3.40.0}"
SERVERLESS_BIN="$SERVICE_DIR/node_modules/.bin/serverless"

SERVICE_NAME="${SERVICE_NAME:-}"
APPLICATION_SERVICE_NAME="${APPLICATION_SERVICE_NAME:-workflow-service}"
DATA_STACK_NAME="${DATA_STACK_NAME:-${STAGE}-${SERVICE_NAME:-$APPLICATION_SERVICE_NAME}-data}"
INFRA_STACK_NAME="${INFRA_STACK_NAME:-${STAGE}-${SERVICE_NAME:-$APPLICATION_SERVICE_NAME}-infra}"
APP_STACK_NAME="${APP_STACK_NAME:-${STACK_NAME:-${STAGE}-${SERVICE_NAME:-$APPLICATION_SERVICE_NAME}}}"

###############################################################################
# 1. Validate prerequisites
###############################################################################

echo "[BUILD] Validating prerequisites"

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is required" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "ERROR: npm is required" >&2
  exit 1
}

if [ ! -d data ] || [ ! -d infra ] || [ ! -f serverless.yml ]; then
  echo "ERROR: SERVICE_DIR=$SERVICE_DIR is missing data/, infra/, or serverless.yml" >&2
  exit 1
fi

if [ ! -f data/serverless.data.yml ] || [ ! -f data/resources/data.yml ]; then
  echo "ERROR: missing data deployment source" >&2
  exit 1
fi

if [ ! -f infra/serverless.infra.yml ] || [ ! -f infra/resources/infra.yml ]; then
  echo "ERROR: missing infra deployment source" >&2
  exit 1
fi

if [ ! -f serverless.yml ] || [ ! -d src ]; then
  echo "ERROR: missing app deployment source" >&2
  exit 1
fi

mkdir -p app

echo "SERVICE_DIR=$SERVICE_DIR"
echo "STAGE=$STAGE"
echo "AWS_REGION=$AWS_REGION"
echo "RESOURCE_NAME_PREFIX=${RESOURCE_NAME_PREFIX:-<unset>}"
echo "SSM_PREFIX=${SSM_PREFIX:-<unset>}"
echo "Pipeline identity SERVICE_NAME=${SERVICE_NAME:-<unset>}"
echo "Application identity APPLICATION_SERVICE_NAME=${APPLICATION_SERVICE_NAME}"
echo "DATA_STACK_NAME=$DATA_STACK_NAME"
echo "INFRA_STACK_NAME=$INFRA_STACK_NAME"
echo "APP_STACK_NAME=$APP_STACK_NAME"

###############################################################################
# Helpers
###############################################################################

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
    echo "ERROR: No CloudFormation template generated in $source_dir" >&2
    ls -la "$source_dir" || true
    exit 1
  fi

  cp "$template" "$dest"
  strip_cfn_outputs "$dest"
  echo "Packaged template: $dest"
}

validate_packaged_template() {
  local path="$1"
  local label="$2"

  if [ ! -s "$path" ]; then
    echo "ERROR: ${label} was not generated" >&2
    exit 1
  fi

  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const label = process.argv[2];
    const raw = fs.readFileSync(file, "utf8");
    let tpl;
    try {
      tpl = JSON.parse(raw);
    } catch (err) {
      console.error(`ERROR: ${label} is not valid JSON CloudFormation output: ${err.message}`);
      process.exit(1);
    }
    if (!tpl || typeof tpl !== "object" || !tpl.Resources || typeof tpl.Resources !== "object") {
      console.error(`ERROR: ${label} is missing CloudFormation Resources`);
      process.exit(1);
    }
    if (Object.keys(tpl.Resources).length === 0) {
      console.error(`ERROR: ${label} has no CloudFormation resources`);
      process.exit(1);
    }
  ' "$path" "$label"
}

install_workflow_npm_deps() {
  echo "Installing workflow npm dependencies from $SERVICE_DIR ..."
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

run_serverless() {
  "$SERVERLESS_BIN" "$@"
}

# The generic pipeline reads ${CODEBUILD_SRC_DIR}/{data,infra,app}/packaged.yaml.
# When this service lives under a nested path (workflow/), copy artifacts there.
publish_pipeline_contract() {
  local contract_root="${CODEBUILD_SRC_DIR:-}"
  if [ -z "$contract_root" ] || [ ! -d "$contract_root" ]; then
    return 0
  fi

  local service_abs contract_abs
  service_abs="$(cd "$SERVICE_DIR" && pwd)"
  contract_abs="$(cd "$contract_root" && pwd)"
  if [ "$service_abs" = "$contract_abs" ]; then
    return 0
  fi

  echo "[BUILD] Copying artifacts to pipeline workspace: $contract_abs"
  mkdir -p "$contract_abs/data" "$contract_abs/infra" "$contract_abs/app/.serverless"
  cp -f "$SERVICE_DIR/data/packaged.yaml" "$contract_abs/data/packaged.yaml"
  cp -f "$SERVICE_DIR/infra/packaged.yaml" "$contract_abs/infra/packaged.yaml"
  cp -f "$SERVICE_DIR/app/packaged.yaml" "$contract_abs/app/packaged.yaml"
  if [ -f "$SERVICE_DIR/app/.serverless/lambda-artifacts.json" ]; then
    cp -f "$SERVICE_DIR/app/.serverless/lambda-artifacts.json" "$contract_abs/app/.serverless/lambda-artifacts.json"
  fi
  if compgen -G "$SERVICE_DIR/app/.serverless/*.zip" > /dev/null; then
    cp -f "$SERVICE_DIR/app/.serverless/"*.zip "$contract_abs/app/.serverless/"
  fi

  test -s "$contract_abs/data/packaged.yaml" || {
    echo "ERROR: data/packaged.yaml was not generated" >&2
    exit 1
  }
  test -s "$contract_abs/infra/packaged.yaml" || {
    echo "ERROR: infra/packaged.yaml was not generated" >&2
    exit 1
  }
  test -s "$contract_abs/app/packaged.yaml" || {
    echo "ERROR: app/packaged.yaml was not generated" >&2
    exit 1
  }

  echo "Pipeline contract artifacts:"
  ls -la "$contract_abs/data/packaged.yaml" \
    "$contract_abs/infra/packaged.yaml" \
    "$contract_abs/app/packaged.yaml"
}

###############################################################################
# Clean previous generated artifacts
###############################################################################

echo "[BUILD] Cleaning generated packaging output"
rm -rf .serverless
rm -rf app/.serverless
rm -f app/packaged.yaml
rm -rf data/.serverless
rm -f data/packaged.yaml
rm -rf infra/.serverless
rm -f infra/packaged.yaml
rm -f packaged.yaml

if command -v free >/dev/null 2>&1; then
  echo "Container memory:"
  free -h || true
fi

###############################################################################
# 2. Install dependencies
###############################################################################

echo "[BUILD] Installing dependencies"

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

echo "Resolving Serverless Framework CLI (required 3.x, pin ${SERVERLESS_VERSION})..."
echo "Using local CLI: $SERVERLESS_BIN"
SLS_VERSION_OUT="$(run_serverless --version)"
echo "$SLS_VERSION_OUT"
if ! echo "$SLS_VERSION_OUT" | grep -qE 'Framework Core: 3\.'; then
  echo "ERROR: Workflow packaging requires Serverless Framework 3.x (got incompatible CLI)." >&2
  exit 1
fi

###############################################################################
# 3. Build application source
# Compilation is performed by serverless-esbuild during app packaging.
# A root `npm run build` is used only when the service defines that script.
###############################################################################

echo "[BUILD] Building application source"

if node -e 'process.exit(require("./package.json").scripts && require("./package.json").scripts.build ? 0 : 1)'; then
  npm run build
else
  echo "[BUILD] No npm build script; TypeScript is compiled by serverless-esbuild during app packaging"
fi

###############################################################################
# 3b. Generate naming contract from deployment context
###############################################################################

echo "[BUILD] Generating service naming from deployment context"
chmod +x "$SCRIPT_DIR/generate-naming.sh"
RESOURCE_NAME_PREFIX="${RESOURCE_NAME_PREFIX:-}" \
SSM_PREFIX="${SSM_PREFIX:-}" \
STAGE="$STAGE" \
SERVICE_NAME="${SERVICE_NAME:-}" \
APPLICATION_SERVICE_NAME="$APPLICATION_SERVICE_NAME" \
AWS_REGION="$AWS_REGION" \
bash "$SCRIPT_DIR/generate-naming.sh"

###############################################################################
# 4. Package DATA
###############################################################################

echo "============================================================"
echo "[PACKAGE] DATA"
echo "============================================================"

echo "Packaging data stack ($DATA_STACK_NAME)..."
if ! (
  cd data
  run_serverless package \
    --config serverless.data.yml \
    --stage "$STAGE" \
    --package .serverless
); then
  echo "ERROR: failed to package data" >&2
  exit 1
fi
copy_packaged_template data/.serverless data/packaged.yaml
if [ ! -s data/packaged.yaml ]; then
  echo "ERROR: data/packaged.yaml was not generated" >&2
  exit 1
fi

echo "Validating Data artifact TableName against generated naming contract..."
RESOURCE_NAME_PREFIX="${RESOURCE_NAME_PREFIX:-}" \
NAMING_FILE="$SERVICE_DIR/config/naming.yml" \
DATA_TEMPLATE="$SERVICE_DIR/data/packaged.yaml" \
node -e '
  const fs = require("fs");
  const naming = fs.readFileSync(process.env.NAMING_FILE, "utf8");
  const prefixMatch = naming.match(/^[ \t]*resourceNamePrefix:[ \t]*(\S+)/m);
  const tableMatch = naming.match(/^[ \t]*tableName:[ \t]*(\S+)/m);
  if (!prefixMatch || !tableMatch) {
    console.error("ERROR: generated naming.yml is missing resourceNamePrefix or tableName");
    process.exit(1);
  }
  const prefix = prefixMatch[1].replace(/^["\x27]|["\x27]$/g, "");
  const expected = tableMatch[1].replace(/^["\x27]|["\x27]$/g, "");
  if (process.env.RESOURCE_NAME_PREFIX && prefix !== process.env.RESOURCE_NAME_PREFIX) {
    console.error(`ERROR: naming.yml prefix "${prefix}" != RESOURCE_NAME_PREFIX "${process.env.RESOURCE_NAME_PREFIX}"`);
    process.exit(1);
  }
  if (!expected.startsWith(prefix + "-")) {
    console.error(`ERROR: tableName "${expected}" must start with "${prefix}-"`);
    process.exit(1);
  }
  const tpl = JSON.parse(fs.readFileSync(process.env.DATA_TEMPLATE, "utf8"));
  const tables = Object.entries(tpl.Resources || {}).filter(([, r]) => r && r.Type === "AWS::DynamoDB::Table");
  if (tables.length !== 1) {
    console.error("ERROR: data/packaged.yaml must contain exactly one AWS::DynamoDB::Table");
    process.exit(1);
  }
  const [logicalId, resource] = tables[0];
  const actual = resource.Properties && resource.Properties.TableName;
  if (actual !== expected) {
    console.error(`ERROR: Packaged ${logicalId} TableName is "${actual}", expected "${expected}"`);
    process.exit(1);
  }
  console.log(`Data artifact TableName OK: ${logicalId} -> ${actual}`);
'

###############################################################################
# 5. Package INFRA
###############################################################################

echo "============================================================"
echo "[PACKAGE] INFRA"
echo "============================================================"

echo "Packaging infra stack ($INFRA_STACK_NAME)..."
if ! (
  cd infra
  run_serverless package \
    --config serverless.infra.yml \
    --stage "$STAGE" \
    --package .serverless
); then
  echo "ERROR: failed to package infra" >&2
  exit 1
fi
copy_packaged_template infra/.serverless infra/packaged.yaml
if [ ! -s infra/packaged.yaml ]; then
  echo "ERROR: infra/packaged.yaml was not generated" >&2
  exit 1
fi

###############################################################################
# 6. Package APP
# Application Serverless config stays at the service root so src/, config/,
# package.json, and ../infra/serverless shared files keep resolving.
###############################################################################

echo "============================================================"
echo "[PACKAGE] APP"
echo "============================================================"

echo "Packaging application stack ($APP_STACK_NAME) (NODE_OPTIONS=$NODE_OPTIONS)..."
if ! run_serverless package \
  --stage "$STAGE" \
  --package .serverless; then
  echo "ERROR: failed to package app" >&2
  exit 1
fi
copy_packaged_template .serverless app/packaged.yaml
if [ ! -s app/packaged.yaml ]; then
  echo "ERROR: app/packaged.yaml was not generated" >&2
  exit 1
fi

mkdir -p app/.serverless
DISCOVER_JS="$SERVICE_DIR/../cicd/pipeline/scripts/discover-lambda-artifacts.cjs"
if [ ! -f "$DISCOVER_JS" ]; then
  echo "ERROR: Lambda artifact discovery script not found: $DISCOVER_JS" >&2
  exit 1
fi

echo "Discovering Lambda ZIP artifacts from the packaged application template..."
SEARCH_DIRS=".serverless:app/.serverless" \
  node "$DISCOVER_JS" app/packaged.yaml --require-zips \
  > app/.serverless/lambda-artifacts.json

DISCOVERY="$(cat app/.serverless/lambda-artifacts.json)"
DISCOVERY="$DISCOVERY" DEST_DIR="app/.serverless" node -e '
  const fs = require("fs");
  const path = require("path");
  const data = JSON.parse(process.env.DISCOVERY);
  const destDir = process.env.DEST_DIR;
  fs.mkdirSync(destDir, { recursive: true });
  for (const art of data.artifacts || []) {
    const dest = path.join(destDir, art.zipName);
    if (path.resolve(art.localPath) !== path.resolve(dest)) {
      fs.copyFileSync(art.localPath, dest);
    }
    if (!fs.existsSync(dest) || !fs.statSync(dest).size) {
      console.error(`ERROR: Failed to stage Lambda artifact ${dest}`);
      process.exit(1);
    }
  }
'

echo "Staged Lambda artifacts in app/.serverless:"
DISCOVERY="$DISCOVERY" node -e '
  const data = JSON.parse(process.env.DISCOVERY);
  for (const art of data.artifacts || []) console.log(`  ${art.zipName}`);
'

###############################################################################
# 7. Validate generated artifacts
###############################################################################

echo "============================================================"
echo "[BUILD] Validating standard artifact contract"
echo "============================================================"

test -s data/packaged.yaml || {
  echo "ERROR: data/packaged.yaml was not generated" >&2
  exit 1
}
test -s infra/packaged.yaml || {
  echo "ERROR: infra/packaged.yaml was not generated" >&2
  exit 1
}
test -s app/packaged.yaml || {
  echo "ERROR: app/packaged.yaml was not generated" >&2
  exit 1
}

validate_packaged_template data/packaged.yaml data/packaged.yaml
validate_packaged_template infra/packaged.yaml infra/packaged.yaml
validate_packaged_template app/packaged.yaml app/packaged.yaml

publish_pipeline_contract

echo "[BUILD] Generated artifacts:"
echo ""
echo "data/packaged.yaml"
echo "infra/packaged.yaml"
echo "app/packaged.yaml"
echo "app/.serverless/*.zip"
echo ""
ls -la "$SERVICE_DIR/data/packaged.yaml" \
  "$SERVICE_DIR/infra/packaged.yaml" \
  "$SERVICE_DIR/app/packaged.yaml"
ls -la "$SERVICE_DIR/app/.serverless"/*.zip "$SERVICE_DIR/app/.serverless/lambda-artifacts.json"

echo "======================================="
echo "SERVICE PACKAGING COMPLETED"
echo "======================================="
