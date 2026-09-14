#!/bin/bash
# Thin entrypoint: Deploy-App stage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/bootstrap-framework.sh"
source "${CICD_SCRIPTS_DIR}/common.sh"
assert_stage
"${CICD_SCRIPTS_DIR}/deploy-cfn.sh" app
