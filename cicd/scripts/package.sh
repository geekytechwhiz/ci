#!/bin/bash
# Optional: pack cicd/pipeline and upload to s3://$ARTIFACT_BUCKET/cicd-framework/pipeline/latest/cicd-pipeline.tgz
# Not required for POC when the GitHub source repository already contains cicd/pipeline.
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

echo "========================================"
echo "PACKAGING CI/CD FRAMEWORK BUNDLE"
echo "========================================"
echo "Service: $SERVICE"
echo "Stage:   $STAGE"

DIST_DIR="$CICD_ROOT/dist"
mkdir -p "$DIST_DIR"

BUNDLE_PATH="$DIST_DIR/cicd-pipeline.tgz"
echo "Creating framework bundle: $BUNDLE_PATH"

tar -czf "$BUNDLE_PATH" -C "$CICD_ROOT" pipeline

echo "Framework bundle created successfully: $(du -h "$BUNDLE_PATH" | cut -f1)"

# If AWS CLI is configured and ARTIFACT_BUCKET is provided, upload bundle
if [ -n "${ARTIFACT_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    KEY="cicd-framework/pipeline/latest/cicd-pipeline.tgz"
    echo "Uploading bundle to s3://${ARTIFACT_BUCKET}/${KEY}..."
    aws s3 cp "$BUNDLE_PATH" "s3://${ARTIFACT_BUCKET}/${KEY}"
  fi
fi

echo "======================================="
echo "Package completed"
echo "======================================="
