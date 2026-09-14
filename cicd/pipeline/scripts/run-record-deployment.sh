#!/bin/bash
# Thin entrypoint: Record-Deployment stage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/bootstrap-framework.sh"
source "${CICD_SCRIPTS_DIR}/common.sh"
assert_stage
"${CICD_SCRIPTS_DIR}/record-deployment.sh"
