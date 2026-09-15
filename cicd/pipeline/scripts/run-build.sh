#!/bin/bash
# Orchestrate the CodePipeline Build stage (service-agnostic).
#
# 1. Source common.sh
# 2. Respect ENABLE_DATA / ENABLE_INFRA / ENABLE_APP (force DEPLOY_* false when disabled)
# 3. Run detect-deployment-changes.sh
# 4. Call ${CI_PATH}/build.sh when present (service packaging hook)
# 5. Else if publish needed, fail — CiPath must provide build.sh
# 6. publish-artifacts.sh + verify-artifacts.sh when any DEPLOY_*=true
# 7. Export DEPLOY_* and CURRENT_COMMIT to deployment-decision.env and stdout

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
assert_stage

ENABLE_DATA="$(normalize_bool "${ENABLE_DATA:-true}")"
ENABLE_INFRA="$(normalize_bool "${ENABLE_INFRA:-true}")"
ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"
export ENABLE_DATA ENABLE_INFRA ENABLE_APP

DEPLOYMENT_DECISION_ENV="${DEPLOYMENT_DECISION_ENV:-deployment-decision.env}"
CI_PATH="${CI_PATH:-${CiPath:-}}"

echo "========================================"
echo "BUILD STAGE (${SERVICE_NAME})"
echo "========================================"
echo "ENABLE_DATA=${ENABLE_DATA} ENABLE_INFRA=${ENABLE_INFRA} ENABLE_APP=${ENABLE_APP}"
echo "CI_PATH=${CI_PATH:-<unset>}"
echo "SERVICE_DIR=${SERVICE_DIR:-<unset>}"

# Change detection
"$SCRIPT_DIR/detect-deployment-changes.sh"

if [ -f "$DEPLOYMENT_DECISION_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOYMENT_DECISION_ENV"
  set +a
elif [ -n "${CODEBUILD_SRC_DIR:-}" ] && [ -f "${CODEBUILD_SRC_DIR}/${DEPLOYMENT_DECISION_ENV}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${CODEBUILD_SRC_DIR}/${DEPLOYMENT_DECISION_ENV}"
  set +a
fi

: "${DEPLOY_DATA:?DEPLOY_DATA missing after change detection}"
: "${DEPLOY_INFRA:?DEPLOY_INFRA missing after change detection}"
: "${DEPLOY_APP:?DEPLOY_APP missing after change detection}"
: "${CURRENT_COMMIT:?CURRENT_COMMIT missing after change detection}"

# Force-disable layers that the service config turned off
if [ "$ENABLE_DATA" != "true" ]; then
  DEPLOY_DATA=false
fi
if [ "$ENABLE_INFRA" != "true" ]; then
  DEPLOY_INFRA=false
fi
if [ "$ENABLE_APP" != "true" ]; then
  DEPLOY_APP=false
fi
export DEPLOY_DATA DEPLOY_INFRA DEPLOY_APP CURRENT_COMMIT

echo "Final deployment decision after ENABLE_* gates:"
echo "  DEPLOY_DATA=$DEPLOY_DATA"
echo "  DEPLOY_INFRA=$DEPLOY_INFRA"
echo "  DEPLOY_APP=$DEPLOY_APP"
echo "  CURRENT_COMMIT=$CURRENT_COMMIT"

need_publish=false
if [ "$DEPLOY_DATA" = "true" ] || [ "$DEPLOY_INFRA" = "true" ] || [ "$DEPLOY_APP" = "true" ]; then
  need_publish=true
fi

resolve_service_build_hook() {
  local candidates=()
  if [ -n "${CI_PATH}" ]; then
    candidates+=("${CI_PATH}/build.sh")
    if [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
      candidates+=("${CODEBUILD_SRC_DIR}/${CI_PATH}/build.sh")
    fi
  fi
  if [ -n "${SERVICE_DIR:-}" ]; then
    candidates+=("${SERVICE_DIR}/ci/build.sh" "${SERVICE_DIR}/build.sh")
  fi
  local c
  for c in "${candidates[@]}"; do
    if [ -f "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

BUILD_HOOK=""
if BUILD_HOOK="$(resolve_service_build_hook)"; then
  echo "Running service packaging hook: $BUILD_HOOK"
  chmod +x "$BUILD_HOOK" || true
  # Pin SERVICE_DIR to the service root that owns the hook (…/ci/build.sh → …/).
  # publish-artifacts.sh / verify-artifacts.sh are separate processes; they
  # inherit this so they look for data/packaged.yaml next to serverless.yml,
  # not at the repository root.
  hook_dir="$(cd "$(dirname "$BUILD_HOOK")" && pwd)"
  if [ "$(basename "$hook_dir")" = "ci" ]; then
    SERVICE_DIR="$(cd "$hook_dir/.." && pwd)"
  else
    SERVICE_DIR="$hook_dir"
  fi
  SERVICE_ROOT="$SERVICE_DIR"
  export SERVICE_DIR SERVICE_ROOT
  echo "SERVICE_DIR=$SERVICE_DIR (from packaging hook)"
  DEPLOY_DATA="$DEPLOY_DATA" \
  DEPLOY_INFRA="$DEPLOY_INFRA" \
  DEPLOY_APP="$DEPLOY_APP" \
  CURRENT_COMMIT="$CURRENT_COMMIT" \
  SERVICE_NAME="$SERVICE_NAME" \
  STAGE="$STAGE" \
  ARTIFACT_BUCKET="$ARTIFACT_BUCKET" \
  SERVICE_DIR="$SERVICE_DIR" \
  SERVICE_ROOT="$SERVICE_ROOT" \
  bash "$BUILD_HOOK"
elif [ "$need_publish" = "true" ]; then
  echo "ERROR: Publish is required (DEPLOY_DATA/INFRA/APP) but no service build.sh was found."
  echo "ERROR: Set CI_PATH (CiPath) to the service CI directory that provides build.sh."
  echo "ERROR: Looked under CI_PATH=${CI_PATH:-<unset>} and SERVICE_DIR=${SERVICE_DIR:-<unset>}"
  exit 1
else
  echo "No layers to deploy; skipping service build.sh and artifact publish."
fi

if [ "$need_publish" = "true" ]; then
  # Ensure manifest exists (build.sh should generate it; fall back here)
  if ! generate_deployment_manifest; then
    echo "ERROR: Failed to generate deployment-manifest.json"
    exit 1
  fi
  "$SCRIPT_DIR/publish-artifacts.sh"
  "$SCRIPT_DIR/verify-artifacts.sh"
fi

# Re-write decision env with gated flags. The buildspec must source this file
# in the CodeBuild parent shell (same command as this script, not only a later
# phase) so CodePipeline VariableCheck receives non-empty values.
decision_path="$DEPLOYMENT_DECISION_ENV"
if [ -n "${CODEBUILD_SRC_DIR:-}" ] && [[ "$decision_path" != /* ]]; then
  decision_path="${CODEBUILD_SRC_DIR}/${DEPLOYMENT_DECISION_ENV}"
fi
write_sourcable_env "$decision_path" DEPLOY_DATA DEPLOY_INFRA DEPLOY_APP CURRENT_COMMIT

export DEPLOY_DATA DEPLOY_INFRA DEPLOY_APP CURRENT_COMMIT
echo "DEPLOY_DATA=$DEPLOY_DATA"
echo "DEPLOY_INFRA=$DEPLOY_INFRA"
echo "DEPLOY_APP=$DEPLOY_APP"
echo "CURRENT_COMMIT=$CURRENT_COMMIT"
echo "========================================"
echo "BUILD STAGE COMPLETED"
echo "========================================"
