#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CICD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE=""
STAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service|-s)
      SERVICE="$2"
      shift 2
      ;;
    --stage|-e)
      STAGE="$2"
      shift 2
      ;;
    *)
      if [ -z "$SERVICE" ]; then
        SERVICE="$1"
      elif [ -z "$STAGE" ]; then
        STAGE="$1"
      fi
      shift
      ;;
  esac
done

SERVICE="${SERVICE:-workflow-service}"
STAGE="${STAGE:-dev}"

STACK_NAME="${STAGE}-${SERVICE}-cicd"
PIPELINE_NAME="${STAGE}-${SERVICE}-pipeline"
TEMPLATE_PATH="$CICD_ROOT/cloudformation/pipeline/generic-codepipeline.yml"

echo "========================================"
echo "DEPLOYING CI/CD PIPELINE STACK"
echo "========================================"
echo "Service:    $SERVICE"
echo "Stage:      $STAGE"
echo "Stack Name: $STACK_NAME"
echo "Template:   $TEMPLATE_PATH"

"$SCRIPT_DIR/validate-config.sh" --service "$SERVICE" --stage "$STAGE"

ENV_CONFIG="$CICD_ROOT/config/environments/${STAGE}.yaml"
SVC_CONFIG="$CICD_ROOT/config/services/${SERVICE}/${STAGE}.yaml"

# Extract parameters using Node
PARAMS=$(node -e '
const fs = require("fs");

function parseYamlSimple(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const getVal = (pattern) => {
    for (const l of lines) {
      if (l.trim().startsWith(pattern)) {
        const idx = l.indexOf(":");
        if (idx !== -1) {
          let val = l.substring(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          return val;
        }
      }
    }
    return "";
  };
  return { content, getVal };
}

const env = parseYamlSimple(process.argv[1]);
const svc = parseYamlSimple(process.argv[2]);

const connArn = svc.getVal("connectionArn:") || env.getVal("connectionArn:") || "arn:aws:codeconnections:ap-south-1:123456789012:connection/example";
const pipeBucket = env.getVal("pipelineBucket:") || "dev-pipeline-artifacts";
const deployBucket = env.getVal("deploymentBucket:") || "dev-deployment-artifacts";
const kmsKeyArn = env.getVal("kmsKeyArn:");
 
const repo = svc.getVal("repository:") || "geekytechwhiz/ci";
const branch = svc.getVal("branch:") || "main";
const ciPath = svc.getVal("ciPath:") || "workflow/ci";
const tableName = svc.getVal("tableName:") || process.argv[3] + "-" + process.argv[4];
const logicalId = svc.getVal("logicalId:") || "WorkflowTable";

 
console.log(`Stage=${process.argv[4]}`);
console.log(`PipelineName=${process.argv[4]}-${process.argv[3]}-pipeline`);
console.log(`CiPath=${ciPath}`);
console.log(`DataTableName=${tableName}`);
console.log(`DataLogicalId=${logicalId}`);
console.log(`ArtifactBucketName=${pipeBucket}`);
console.log(`ArtifactBucket=${deployBucket}`);
console.log(`GitHubConnectionArn=${connArn}`);
console.log(`GitHubFullRepositoryId=${repo}`);
console.log(`GitHubBranch=${branch}`);
if (kmsKeyArn) {
  console.log(`ArtifactKmsKeyArn=${kmsKeyArn}`);
}
' "$ENV_CONFIG" "$SVC_CONFIG" "$SERVICE" "$STAGE")

echo "Derived Parameters:"
echo "$PARAMS"

if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    echo "Executing aws cloudformation deploy..."
    # Convert PARAMS lines to array for aws cloudformation deploy
    PARAM_ARGS=()
    S3_BUCKET=""
    while read -r line; do
      if [ -n "$line" ]; then
        PARAM_ARGS+=("$line")
        if [[ "$line" == ArtifactBucketName=* ]]; then
          S3_BUCKET="${line#ArtifactBucketName=}"
        fi
      fi
    done <<< "$PARAMS"

    S3_BUCKET="${ARTIFACT_BUCKET:-$S3_BUCKET}"

    AWS_DEPLOY_CMD=(
      aws cloudformation deploy
      --template-file "$TEMPLATE_PATH"
      --stack-name "$STACK_NAME"
      --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
      --parameter-overrides "${PARAM_ARGS[@]}"
    )
    if [ -n "$S3_BUCKET" ]; then
      AWS_DEPLOY_CMD+=(--s3-bucket "$S3_BUCKET")
    fi

    "${AWS_DEPLOY_CMD[@]}"

    echo "Pipeline stack deployment COMPLETED."
  else
    echo "AWS CLI credentials unconfigured — skipped live AWS deployment call."
  fi
else
  echo "AWS CLI not installed — skipped live AWS deployment call."
fi

echo "======================================="
echo "Pipeline deploy script executed successfully."
echo "======================================="
