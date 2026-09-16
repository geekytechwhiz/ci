#!/bin/bash
# Thin entrypoint: Smoke-Test stage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bootstrap-framework.sh
source "$SCRIPT_DIR/bootstrap-framework.sh"
"${CICD_SCRIPTS_DIR}/smoke-test.sh"
