#!/bin/bash
# Generic CloudFormation deploy for data | infra | app layers.
#
# Usage:
#   ./deploy-cfn.sh data|infra|app
#   LAYER=data ./deploy-cfn.sh
#
# Stack names from env (via common.sh):
#   data  → DATA_STACK_NAME
#   infra → INFRA_STACK_NAME
#   app   → APP_STACK_NAME / STACK_NAME
#
# Fetches the immutable packaged template when CURRENT_COMMIT is set.
# Optional CFN_DEPLOY_ROLE_ARN is passed as --role-arn.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

: "${STAGE:?STAGE must be set (dev, stg, or prd)}"
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
assert_stage

LAYER="${1:-${LAYER:-}}"
case "$LAYER" in
  data|infra|app) ;;
  *)
    echo "ERROR: LAYER must be data, infra, or app (got: ${LAYER:-unset})"
    echo "Usage: $0 data|infra|app"
    exit 1
    ;;
esac

cd "$SERVICE_DIR"

case "$LAYER" in
  data)
    STACK="${DATA_STACK_NAME}"
    TEMPLATE="${DATA_PACKAGED_TEMPLATE:-data/packaged.yaml}"
    TAG_STACK=data
    ;;
  infra)
    STACK="${INFRA_STACK_NAME}"
    TEMPLATE="${INFRA_PACKAGED_TEMPLATE:-infra/packaged.yaml}"
    TAG_STACK=infrastructure
    ;;
  app)
    STACK="${APP_STACK_NAME}"
    TEMPLATE="${PACKAGED_TEMPLATE:-app/packaged.yaml}"
    TAG_STACK=application
    ;;
esac

echo "======================================="
echo "CLOUDFORMATION DEPLOY (${LAYER})"
echo "======================================="
echo "  service=$SERVICE_NAME"
echo "  stage=$STAGE"
echo "  stack=$STACK"
echo "  template=$TEMPLATE"
echo "  currentCommit=${CURRENT_COMMIT:-<local>}"

fetch_immutable_packaged_template "$LAYER" "$TEMPLATE"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Template not found: $TEMPLATE"
  echo "Pipeline requires s3://\$ARTIFACT_BUCKET/${SERVICE_NAME}/\$CURRENT_COMMIT/${LAYER}/packaged.yaml"
  exit 1
fi

# Optional app-layer safety: refuse deploy if live stack still owns EventBus/SQS
# unless ALLOW_APP_RESOURCE_REMOVAL=true.
if [ "$LAYER" = "app" ] && aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK" >/dev/null 2>&1; then
  live_types="$(aws cloudformation list-stack-resources \
    --region "$AWS_REGION" \
    --stack-name "$STACK" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Events::EventBus' || ResourceType=='AWS::SQS::Queue'].LogicalResourceId" \
    --output text 2>/dev/null || true)"
  if [ -n "${live_types// }" ]; then
    echo "ERROR: $STACK still owns EventBus/SQS: $live_types"
    echo "Deploying this application template would DELETE those resources."
    echo "Override only after retain is applied: ALLOW_APP_RESOURCE_REMOVAL=true"
    if [ "${ALLOW_APP_RESOURCE_REMOVAL:-false}" != "true" ]; then
      exit 1
    fi
    echo "WARN: ALLOW_APP_RESOURCE_REMOVAL=true — continuing"
  fi
fi

cfn_deploy_failed() {
  local rc=$?
  echo "ERROR: CloudFormation deploy failed for ${STACK} (layer=${LAYER}, exit=${rc})"
  print_cfn_failure_diagnostics "$STACK"
  exit "$rc"
}

trap cfn_deploy_failed ERR

# shellcheck disable=SC2046
aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --s3-bucket "$(environment_artifact_bucket)" \
  --s3-prefix "$(cfn_template_upload_prefix "$LAYER")" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  $(cfn_deploy_role_args) \
  --tags \
    "Service=${SERVICE_NAME}" \
    "Stage=${STAGE}" \
    "ManagedBy=serverless" \
    "Stack=${TAG_STACK}"

trap - ERR

echo "======================================="
echo "CLOUDFORMATION DEPLOY (${LAYER}) COMPLETED"
echo "======================================="
