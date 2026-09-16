```bash
#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Workflow Service - Build & Package
#
# Responsibility:
#   1. Build application source
#   2. Package service-owned CloudFormation/Serverless templates
#   3. Produce the standard CI/CD artifact contract:
#
#        data/packaged.yaml
#        infra/packaged.yaml
#        app/packaged.yaml
#
# This script MUST NOT:
#   - Deploy CloudFormation stacks
#   - Upload deployment artifacts to S3
#   - Update SSM deployment state
#   - Execute CodePipeline actions
#   - Perform data recovery/import
#   - Modify AWS infrastructure
#
# Deployment is owned by the generic CI/CD pipeline.
###############################################################################

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "============================================================"
echo "BUILD: workflow-service"
echo "============================================================"
echo "ROOT_DIR=$ROOT_DIR"
echo "NODE_VERSION=$(node --version)"
echo "NPM_VERSION=$(npm --version)"
echo "============================================================"

###############################################################################
# Configuration
###############################################################################

DATA_DIR="$ROOT_DIR/data"
INFRA_DIR="$ROOT_DIR/infra"
APP_DIR="$ROOT_DIR/app"

DATA_TEMPLATE="$DATA_DIR/serverless.yml"
INFRA_TEMPLATE="$INFRA_DIR/serverless.yml"
APP_TEMPLATE="$APP_DIR/serverless.yml"

###############################################################################
# Validate required tooling
###############################################################################

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is required" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "ERROR: npm is required" >&2
  exit 1
}

command -v npx >/dev/null 2>&1 || {
  echo "ERROR: npx is required" >&2
  exit 1
}

###############################################################################
# Install dependencies
###############################################################################

echo "[BUILD] Installing dependencies"

if [ -f "$ROOT_DIR/package-lock.json" ]; then
  npm ci
else
  npm install
fi

###############################################################################
# Build application source
###############################################################################

echo "[BUILD] Building application"

# Use the repository's normal build command when available.
if npm run | grep -qE '^  build'; then
  npm run build
else
  echo "[BUILD] No root build script found; skipping application compilation"
fi

###############################################################################
# Validate deployment source templates
###############################################################################

echo "[BUILD] Validating deployment templates"

test -f "$DATA_TEMPLATE" || {
  echo "ERROR: missing $DATA_TEMPLATE" >&2
  exit 1
}

test -f "$INFRA_TEMPLATE" || {
  echo "ERROR: missing $INFRA_TEMPLATE" >&2
  exit 1
}

test -f "$APP_TEMPLATE" || {
  echo "ERROR: missing $APP_TEMPLATE" >&2
  exit 1
}

###############################################################################
# Clean previous generated artifacts
###############################################################################

echo "[BUILD] Cleaning generated packaging output"

rm -f "$DATA_DIR/packaged.yaml"
rm -f "$INFRA_DIR/packaged.yaml"
rm -f "$APP_DIR/packaged.yaml"

rm -rf "$DATA_DIR/.serverless"
rm -rf "$INFRA_DIR/.serverless"
rm -rf "$APP_DIR/.serverless"

###############################################################################
# Package DATA
###############################################################################

echo "============================================================"
echo "[PACKAGE] DATA"
echo "============================================================"

(
  cd "$DATA_DIR"

  npx serverless package \
    --config serverless.yml \
    --stage "${STAGE:-dev}"
)

test -f "$DATA_DIR/.serverless/cloudformation-template-update-stack.json" || {
  echo "ERROR: data Serverless package was not generated" >&2
  exit 1
}

cp \
  "$DATA_DIR/.serverless/cloudformation-template-update-stack.json" \
  "$DATA_DIR/packaged.yaml"

###############################################################################
# Package INFRA
###############################################################################

echo "============================================================"
echo "[PACKAGE] INFRA"
echo "============================================================"

(
  cd "$INFRA_DIR"

  npx serverless package \
    --config serverless.yml \
    --stage "${STAGE:-dev}"
)

test -f "$INFRA_DIR/.serverless/cloudformation-template-update-stack.json" || {
  echo "ERROR: infra Serverless package was not generated" >&2
  exit 1
}

cp \
  "$INFRA_DIR/.serverless/cloudformation-template-update-stack.json" \
  "$INFRA_DIR/packaged.yaml"

###############################################################################
# Package APP
###############################################################################

echo "============================================================"
echo "[PACKAGE] APP"
echo "============================================================"

(
  cd "$APP_DIR"

  npx serverless package \
    --config serverless.yml \
    --stage "${STAGE:-dev}"
)

test -f "$APP_DIR/.serverless/cloudformation-template-update-stack.json" || {
  echo "ERROR: app Serverless package was not generated" >&2
  exit 1
}

cp \
  "$APP_DIR/.serverless/cloudformation-template-update-stack.json" \
  "$APP_DIR/packaged.yaml"

###############################################################################
# Final artifact validation
###############################################################################

echo "============================================================"
echo "[BUILD] Validating standard artifact contract"
echo "============================================================"

test -s "$DATA_DIR/packaged.yaml" || {
  echo "ERROR: data/packaged.yaml is missing or empty" >&2
  exit 1
}

test -s "$INFRA_DIR/packaged.yaml" || {
  echo "ERROR: infra/packaged.yaml is missing or empty" >&2
  exit 1
}

test -s "$APP_DIR/packaged.yaml" || {
  echo "ERROR: app/packaged.yaml is missing or empty" >&2
  exit 1
}

###############################################################################
# Display artifact information
###############################################################################

echo ""
echo "[BUILD] Generated artifacts:"
echo ""

ls -lh \
  "$DATA_DIR/packaged.yaml" \
  "$INFRA_DIR/packaged.yaml" \
  "$APP_DIR/packaged.yaml"

echo ""
echo "============================================================"
echo "BUILD SUCCESSFUL"
echo "============================================================"
echo "data/packaged.yaml  : READY"
echo "infra/packaged.yaml : READY"
echo "app/packaged.yaml   : READY"
echo "============================================================"
```
