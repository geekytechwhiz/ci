#!/bin/bash
# Optional convenience wrapper around the Common CI/CD CloudFormation template.
#
# This script is NOT a prerequisite for the pipeline. For the POC, DevOps can
# create/update the same stack directly in the AWS CloudFormation console or
# with `aws cloudformation deploy` using
# cicd/cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml.
#
# This wrapper only:
#   1. Validates local YAML config (when present)
#   2. Maps that config to CloudFormation parameters
#   3. Uploads the template body via --s3-bucket (template exceeds 51,200 bytes)
#   4. Invokes `aws cloudformation deploy`
#
# It must not create IAM roles, CodeBuild projects, buckets, pipelines, or
# generated infrastructure files. Those belong to the CloudFormation template.
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
TEMPLATE_PATH="$CICD_ROOT/cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml"

echo "========================================"
echo "OPTIONAL CI/CD PIPELINE STACK WRAPPER"
echo "========================================"
echo "This script only calls CloudFormation. It does not bootstrap pipeline resources."
echo "Service:    $SERVICE"
echo "Stage:      $STAGE"
echo "Stack Name: $STACK_NAME"
echo "Template:   $TEMPLATE_PATH"

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "ERROR: CloudFormation template not found: $TEMPLATE_PATH" >&2
  exit 1
fi

"$SCRIPT_DIR/validate-config.sh" --service "$SERVICE" --stage "$STAGE"

ENV_CONFIG="$CICD_ROOT/config/environments/${STAGE}.yaml"
SVC_CONFIG="$CICD_ROOT/config/services/${SERVICE}/${STAGE}.yaml"

# Extract parameters using Node. Empty required values fail — no dummy ARNs/buckets.
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
          return unquote(val);
        }
      }
    }
    return "";
  };
  const getNested = (section, key) => {
    let inSection = false;
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!l.startsWith(" ") && trimmed.startsWith(section + ":")) {
        inSection = true;
        continue;
      }
      if (inSection && !l.startsWith("  ")) {
        inSection = false;
      }
      if (inSection && l.startsWith("  ") && trimmed.startsWith(key + ":")) {
        const idx = trimmed.indexOf(":");
        let val = trimmed.substring(idx + 1).trim();
        return unquote(val);
      }
    }
    return "";
  };
  const getRegionShort = (region) => {
    let inSection = false;
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!l.startsWith(" ") && trimmed.startsWith("naming:")) {
        inSection = true;
        continue;
      }
      if (inSection && !l.startsWith("  ")) {
        inSection = false;
      }
      if (inSection && l.startsWith("    ") && trimmed.startsWith(region + ":")) {
        const idx = trimmed.indexOf(":");
        let val = trimmed.substring(idx + 1).trim();
        return unquote(val);
      }
    }
    return "";
  };
  return { content, getVal, getNested, getRegionShort };
}

function unquote(val) {
  var v = (val || "").trim();
  if (v.length >= 2) {
    var q = v.charCodeAt(0);
    if ((q === 34 || q === 39) && v.charCodeAt(v.length - 1) === q) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}
function requireValue(name, value) {
  const v = unquote(value);
  if (!v || v.indexOf("REPLACE_ME_") === 0) {
    throw new Error("Missing required config value: " + name + " (fill cicd/config or create the stack in CloudFormation with parameters)");
  }
  return v;
}

const env = parseYamlSimple(process.argv[1]);
const svc = parseYamlSimple(process.argv[2]);
const serviceName = process.argv[3];
const stage = process.argv[4];

const connArn = requireValue(
  "github.connectionArn / source.connectionArn",
  svc.getVal("connectionArn:") || env.getVal("connectionArn:")
);
const pipeBucket = requireValue("artifacts.pipelineBucket", env.getVal("pipelineBucket:"));
const deployBucket = requireValue("artifacts.deploymentBucket", env.getVal("deploymentBucket:"));
const awsRegion = env.getNested("environment", "awsRegion:") || "us-east-1";

const repo = requireValue("source.repository", svc.getVal("repository:"));
const branch = requireValue("source.branch", svc.getVal("branch:"));
const ciPath = svc.getVal("ciPath:") || "ci";
const logicalId = svc.getVal("logicalId:") || "";
const ownershipPurpose = svc.getVal("Purpose:") || "";
const ownershipService = svc.getVal("Service:") || "";

const platformCode = env.getNested("naming", "platformCode:") || "nv";
const projectCode = env.getNested("naming", "projectCode:") || "mvx";
const regionShort = env.getRegionShort(awsRegion) || "";

const explicitPrefix = svc.getVal("resourceNamePrefix:") || env.getNested("naming", "resourceNamePrefix:") || "";
const resourceNamePrefix = explicitPrefix || (regionShort
  ? `${platformCode}${stage}-${regionShort}-${projectCode}`
  : "");
const ssmPrefix = svc.getVal("prefix:") || (resourceNamePrefix ? `/${resourceNamePrefix}/${serviceName}` : "");

const requiredFromSvc = [];
let inSsmRequired = false;
for (const l of svc.content.split("\n")) {
  const trimmed = l.trim();
  if (trimmed.startsWith("required:")) {
    inSsmRequired = true;
    continue;
  }
  if (inSsmRequired) {
    if (trimmed.startsWith("- ")) {
      requiredFromSvc.push(trimmed.slice(2).trim());
      continue;
    }
    if (!l.startsWith("  ") && !l.startsWith("    ")) {
      inSsmRequired = false;
    }
  }
}
const requiredSsm = requiredFromSvc.length
  ? requiredFromSvc.join(",")
  : "TABLE_NAME,TABLE_ARN,STREAM_ARN,SQS_QUEUE_URL,SQS_QUEUE_ARN,EVENT_BUS_NAME,EVENT_BUS_ARN";

console.log(`ServiceName=${serviceName}`);
console.log(`Stage=${stage}`);
console.log(`PipelineName=${stage}-${serviceName}-pipeline`);
console.log(`CiPath=${ciPath}`);
if (logicalId) {
  console.log(`DataLogicalId=${logicalId}`);
}
if (ssmPrefix) {
  console.log(`SsmPrefix=${ssmPrefix}`);
}
if (ownershipPurpose) {
  console.log(`OwnershipTagPurpose=${ownershipPurpose}`);
}
if (ownershipService) {
  console.log(`OwnershipTagService=${ownershipService}`);
}
console.log(`RequiredSsmParameters=${requiredSsm}`);
console.log(`PlatformCode=${platformCode}`);
console.log(`ProjectCode=${projectCode}`);
if (regionShort) {
  console.log(`RegionShortCode=${regionShort}`);
}
if (resourceNamePrefix) {
  console.log(`ResourceNamePrefix=${resourceNamePrefix}`);
}
console.log(`ArtifactBucketName=${pipeBucket}`);
console.log(`ArtifactBucket=${deployBucket}`);
console.log(`GitHubConnectionArn=${connArn}`);
console.log(`GitHubFullRepositoryId=${repo}`);
console.log(`GitHubBranch=${branch}`);
' "$ENV_CONFIG" "$SVC_CONFIG" "$SERVICE" "$STAGE")

echo "Derived Parameters:"
echo "$PARAMS"

if echo "$PARAMS" | grep -Eq '^(GitHubConnectionArn|ArtifactBucketName|ArtifactBucket|GitHubFullRepositoryId|GitHubBranch)=(|""|REPLACE_ME_)'; then
  echo "ERROR: Required CloudFormation parameters are empty. Fill cicd/config YAML or create the stack in the CloudFormation console with explicit parameters. This wrapper will not invent buckets, connections, or IAM." >&2
  exit 1
fi

if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    echo "Executing aws cloudformation deploy (same template as a manual console/CLI create)..."
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
    if [ -z "$S3_BUCKET" ]; then
      echo "ERROR: ArtifactBucketName / ARTIFACT_BUCKET is required to upload the template (size exceeds the 51,200-byte inline limit)." >&2
      exit 1
    fi

    AWS_DEPLOY_CMD=(
      aws cloudformation deploy
      --template-file "$TEMPLATE_PATH"
      --stack-name "$STACK_NAME"
      --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
      --s3-bucket "$S3_BUCKET"
      --s3-prefix "cicd/cloudformation/${STACK_NAME}"
      --parameter-overrides "${PARAM_ARGS[@]}"
    )

    echo "Command: ${AWS_DEPLOY_CMD[*]}"
    "${AWS_DEPLOY_CMD[@]}"

    echo "Pipeline stack deployment COMPLETED."
    echo "Start the pipeline manually from the CodePipeline console if DetectSourceChanges=false."
  else
    echo "AWS CLI credentials unconfigured — skipped live AWS deployment call."
    echo "Manual equivalent: upload the template to S3, then create/update stack ${STACK_NAME}."
  fi
else
  echo "AWS CLI not installed — skipped live AWS deployment call."
fi

echo "======================================="
echo "Optional pipeline deploy wrapper finished."
echo "======================================="
