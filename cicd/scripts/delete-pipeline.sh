#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

echo "========================================"
echo "DELETING CI/CD PIPELINE STACK"
echo "========================================"
echo "Service:    $SERVICE"
echo "Stage:      $STAGE"
echo "Stack Name: $STACK_NAME"

if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    echo "Executing aws cloudformation delete-stack..."
    aws cloudformation delete-stack --stack-name "$STACK_NAME"
    echo "Deletion request submitted for $STACK_NAME."
  else
    echo "AWS CLI credentials unconfigured — skipped live delete-stack call."
  fi
else
  echo "AWS CLI not installed — skipped live delete-stack call."
fi

echo "======================================="
echo "Pipeline delete script executed successfully."
echo "======================================="
