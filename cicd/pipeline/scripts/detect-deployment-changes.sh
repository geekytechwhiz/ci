#!/bin/bash
# Connect detect-changes.sh to the Build stage (service-agnostic).
#
# Reads LAST_DEPLOYED_COMMIT from SSM at:
#   /${STAGE}/${SERVICE_NAME}/cicd/LAST_DEPLOYED_COMMIT
# Fail closed on AccessDenied. First deploy (ParameterNotFound) → all enabled layers true.
#
# Does NOT write deployment-manifest.json (Build / service build.sh does that).
# Does NOT update LAST_DEPLOYED_COMMIT. Does NOT publish artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

DETECT_CHANGES="$SCRIPT_DIR/detect-changes.sh"

CURRENT_COMMIT="${CURRENT_COMMIT:-}"
BASELINE_COMMIT=""
FIRST_DEPLOYMENT=false
DEPLOY_DATA=false
DEPLOY_INFRA=false
DEPLOY_APP=false
CHANGED_FILES_OUTPUT="${CHANGED_FILES_OUTPUT:-}"
DEPLOYMENT_DECISION_ENV="${DEPLOYMENT_DECISION_ENV:-deployment-decision.env}"

ENABLE_DATA="$(normalize_bool "${ENABLE_DATA:-true}")"
ENABLE_INFRA="$(normalize_bool "${ENABLE_INFRA:-true}")"
ENABLE_APP="$(normalize_bool "${ENABLE_APP:-true}")"

usage_error() {
  echo "ERROR: $*" >&2
  exit 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

require_inputs() {
  : "${STAGE:?STAGE must be set (dev, stg, or prd)}"
  : "${AWS_REGION:?AWS_REGION must be set}"
  : "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
  : "${SERVICE_NAME:?SERVICE_NAME must be set}"
  assert_stage
  # common.sh already set LAST_DEPLOYED_COMMIT_PARAM
  if [ ! -f "$DETECT_CHANGES" ]; then
    usage_error "detect-changes.sh not found at $DETECT_CHANGES"
  fi
}

resolve_current_commit() {
  local candidate="${CURRENT_COMMIT:-}"
  if [ -z "$candidate" ]; then
    candidate="${CODEBUILD_RESOLVED_SOURCE_VERSION:-}"
  fi
  if [ -z "$candidate" ] && is_git_sha "${CODEBUILD_SOURCE_VERSION:-}"; then
    candidate="$CODEBUILD_SOURCE_VERSION"
  fi
  candidate="$(trim "$candidate")"
  if ! is_git_sha "$candidate"; then
    echo "ERROR: Cannot determine the current source commit SHA." >&2
    echo "Set CODEBUILD_RESOLVED_SOURCE_VERSION (preferred) or CURRENT_COMMIT to a Git commit SHA." >&2
    echo "CODEBUILD_RESOLVED_SOURCE_VERSION=${CODEBUILD_RESOLVED_SOURCE_VERSION:-<unset>}" >&2
    echo "CODEBUILD_SOURCE_VERSION=${CODEBUILD_SOURCE_VERSION:-<unset>}" >&2
    echo "The Build cannot silently deploy all without a usable current commit." >&2
    exit 1
  fi
  CURRENT_COMMIT="$candidate"
}

# Exit 0: prints SHA. Exit 2: ParameterNotFound. Other errors: exit 1.
get_last_deployed_commit() {
  local stdout_file stderr_file rc stdout stderr
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  set +e
  aws ssm get-parameter \
    --name "$LAST_DEPLOYED_COMMIT_PARAM" \
    --region "$AWS_REGION" \
    --query 'Parameter.Value' \
    --output text \
    >"$stdout_file" \
    2>"$stderr_file"
  rc=$?
  set -e
  stdout="$(cat "$stdout_file")"
  stderr="$(cat "$stderr_file")"
  rm -f "$stdout_file" "$stderr_file"

  if [ "$rc" -eq 0 ]; then
    stdout="$(trim "$stdout")"
    if [ -z "$stdout" ] || [ "$stdout" = "None" ] || [ "$stdout" = "null" ]; then
      echo "ERROR: SSM parameter $LAST_DEPLOYED_COMMIT_PARAM exists but the value is empty." >&2
      exit 1
    fi
    if ! is_git_sha "$stdout"; then
      echo "ERROR: SSM parameter $LAST_DEPLOYED_COMMIT_PARAM is not a Git commit SHA: $stdout" >&2
      exit 1
    fi
    printf '%s' "$stdout"
    return 0
  fi

  if printf '%s\n' "$stderr" | grep -q 'ParameterNotFound'; then
    return 2
  fi

  if printf '%s\n' "$stderr" | grep -Eqi 'AccessDenied|UnauthorizedException'; then
    echo "ERROR: Access denied reading SSM parameter $LAST_DEPLOYED_COMMIT_PARAM." >&2
    echo "This is not treated as a missing baseline / first deployment." >&2
    echo "The Build cannot continue." >&2
    echo "$stderr" >&2
    exit 1
  fi

  if printf '%s\n' "$stderr" | grep -Eqi 'UnrecognizedClient|ExpiredToken|InvalidClientTokenId'; then
    echo "ERROR: Invalid AWS credentials or configuration while reading $LAST_DEPLOYED_COMMIT_PARAM." >&2
    echo "This is not treated as a missing baseline / first deployment." >&2
    echo "$stderr" >&2
    exit 1
  fi

  echo "ERROR: Failed to read SSM parameter $LAST_DEPLOYED_COMMIT_PARAM" >&2
  echo "Region: $AWS_REGION" >&2
  echo "$stderr" >&2
  exit 1
}

read_baseline() {
  local rc=0
  local value=""
  set +e
  value="$(get_last_deployed_commit)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    BASELINE_COMMIT="$value"
    FIRST_DEPLOYMENT=false
    return 0
  fi
  if [ "$rc" -eq 2 ]; then
    BASELINE_COMMIT=""
    FIRST_DEPLOYMENT=true
    return 0
  fi
  exit 1
}

echo_changed_files_unavailable() {
  local baseline="$1"
  local current="$2"
  local reason="$3"
  echo "ERROR: Cannot obtain changed files between baseline and current commit." >&2
  echo "Baseline: $baseline" >&2
  echo "Current:  $current" >&2
  echo "Reason:   $reason" >&2
  echo >&2
  echo "CodePipeline Source currently uses OutputArtifactFormat: CODE_ZIP." >&2
  echo "That artifact does not include Git history, so" >&2
  echo "  git diff <LAST_DEPLOYED_COMMIT> <CURRENT_COMMIT>" >&2
  echo "cannot run in this workspace." >&2
  echo >&2
  echo "Next step: provide Git history in CodeBuild (for example CODEBUILD_CLONE_REF" >&2
  echo "on the existing CodeStar connection) or inject CHANGED_FILES_LIST." >&2
}

compare_source_commits() {
  local baseline="$1"
  local current="$2"
  local outfile="$3"
  local repo="${REPO_ROOT:-${CODEBUILD_SRC_DIR:-.}}"
  local git_err

  if ! command -v git >/dev/null 2>&1; then
    echo_changed_files_unavailable "$baseline" "$current" "git is not installed in this environment"
    exit 1
  fi

  git_err="$(git -C "$repo" rev-parse --is-inside-work-tree 2>&1)" || {
    echo_changed_files_unavailable "$baseline" "$current" "workspace has no Git metadata (${git_err})"
    exit 1
  }

  git_err="$(git -C "$repo" cat-file -e "${baseline}^{commit}" 2>&1)" || {
    echo_changed_files_unavailable "$baseline" "$current" "baseline commit is not in this Git workspace (${git_err})"
    exit 1
  }

  git_err="$(git -C "$repo" cat-file -e "${current}^{commit}" 2>&1)" || {
    echo_changed_files_unavailable "$baseline" "$current" "current commit is not in this Git workspace (${git_err})"
    exit 1
  }

  git -C "$repo" diff --name-only "$baseline" "$current" >"$outfile"
}

list_changed_files() {
  local baseline="$1"
  local current="$2"
  local outfile="$3"

  if [ -n "${CHANGED_FILES_LIST:-}" ]; then
    if [ ! -f "$CHANGED_FILES_LIST" ]; then
      usage_error "CHANGED_FILES_LIST is not a readable file: $CHANGED_FILES_LIST"
    fi
    grep -v '^[[:space:]]*$' "$CHANGED_FILES_LIST" >"$outfile" || true
    return 0
  fi

  compare_source_commits "$baseline" "$current" "$outfile"
}

apply_enable_gates() {
  if [ "$ENABLE_DATA" != "true" ]; then
    DEPLOY_DATA=false
  fi
  if [ "$ENABLE_INFRA" != "true" ]; then
    DEPLOY_INFRA=false
  fi
  if [ "$ENABLE_APP" != "true" ]; then
    DEPLOY_APP=false
  fi
}

write_decision_env() {
  local dir path
  path="$DEPLOYMENT_DECISION_ENV"
  if [ -n "${CODEBUILD_SRC_DIR:-}" ] && [[ "$path" != /* ]]; then
    path="${CODEBUILD_SRC_DIR}/${DEPLOYMENT_DECISION_ENV}"
  fi
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  cat >"$path" <<EOF
DEPLOY_DATA=$DEPLOY_DATA
DEPLOY_INFRA=$DEPLOY_INFRA
DEPLOY_APP=$DEPLOY_APP
CURRENT_COMMIT=$CURRENT_COMMIT
EOF
  DEPLOYMENT_DECISION_ENV="$path"
  export DEPLOY_DATA DEPLOY_INFRA DEPLOY_APP CURRENT_COMMIT
}

read_flags_from_parser_output() {
  local output="$1"
  DEPLOY_DATA="$(printf '%s\n' "$output" | sed -n 's/^DEPLOY_DATA=//p' | tail -n 1)"
  DEPLOY_INFRA="$(printf '%s\n' "$output" | sed -n 's/^DEPLOY_INFRA=//p' | tail -n 1)"
  DEPLOY_APP="$(printf '%s\n' "$output" | sed -n 's/^DEPLOY_APP=//p' | tail -n 1)"
  if [ -z "$DEPLOY_DATA" ] || [ -z "$DEPLOY_INFRA" ] || [ -z "$DEPLOY_APP" ]; then
    echo "ERROR: detect-changes.sh did not print DEPLOY_DATA / DEPLOY_INFRA / DEPLOY_APP" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

print_banner_start() {
  echo "========================================"
  echo "Change Detection (${SERVICE_NAME})"
  echo "========================================"
  echo
  echo "Stage:"
  echo "$STAGE"
  echo
  echo "SSM baseline parameter:"
  echo "$LAST_DEPLOYED_COMMIT_PARAM"
  echo
  echo "Current commit:"
  echo "$CURRENT_COMMIT"
  echo
  echo "Last successful deployment:"
  if [ "$FIRST_DEPLOYMENT" = true ]; then
    echo "NOT FOUND"
  else
    echo "$BASELINE_COMMIT"
  fi
}

print_banner_end() {
  echo
  echo "Deployment decision:"
  echo "  Data : $DEPLOY_DATA"
  echo "  Infra: $DEPLOY_INFRA"
  echo "  App  : $DEPLOY_APP"
  echo
  if [ "$FIRST_DEPLOYMENT" = true ]; then
    echo "Reason:"
    echo "First deployment / no successful deployment baseline."
    echo
  fi
  echo "Decision env:"
  echo "$DEPLOYMENT_DECISION_ENV"
  echo
  echo "========================================"
}

run_first_deployment() {
  DEPLOY_DATA=true
  DEPLOY_INFRA=true
  DEPLOY_APP=true
  apply_enable_gates
  print_banner_start
  echo
  echo "No previous successful deployment commit found."
  echo "This is treated as the first deployment."
  echo "Deployment decision (after ENABLE_* gates):"
  echo "  Data : $DEPLOY_DATA"
  echo "  Infra: $DEPLOY_INFRA"
  echo "  App  : $DEPLOY_APP"
  write_decision_env
  print_banner_end
}

run_existing_baseline() {
  local parser_out parser_manifest
  CHANGED_FILES_OUTPUT="${CHANGED_FILES_OUTPUT:-$(mktemp "${TMPDIR:-/tmp}/changed-files.XXXXXX")}"
  list_changed_files "$BASELINE_COMMIT" "$CURRENT_COMMIT" "$CHANGED_FILES_OUTPUT"

  print_banner_start
  echo
  echo "Changed files:"
  if [ ! -s "$CHANGED_FILES_OUTPUT" ]; then
    echo "  (none)"
  else
    sed 's/^/  /' "$CHANGED_FILES_OUTPUT"
  fi
  echo

  parser_manifest="$(mktemp "${TMPDIR:-/tmp}/detect-changes-manifest.XXXXXX")"
  parser_out="$(
    ENABLE_DATA="$ENABLE_DATA" \
    ENABLE_INFRA="$ENABLE_INFRA" \
    ENABLE_APP="$ENABLE_APP" \
    SERVICE_NAME="$SERVICE_NAME" \
    SERVICE_ROOT="${SERVICE_ROOT:-}" \
    DEPLOYMENT_MANIFEST="$parser_manifest" \
    "$DETECT_CHANGES" "$CHANGED_FILES_OUTPUT"
  )"
  read_flags_from_parser_output "$parser_out"
  apply_enable_gates
  write_decision_env
  print_banner_end
}

main() {
  require_inputs
  resolve_current_commit
  read_baseline

  if [ "$FIRST_DEPLOYMENT" = true ]; then
    run_first_deployment
  else
    run_existing_baseline
  fi

  echo "DEPLOY_DATA=$DEPLOY_DATA"
  echo "DEPLOY_INFRA=$DEPLOY_INFRA"
  echo "DEPLOY_APP=$DEPLOY_APP"
}

main
