#!/bin/bash
# Generic CodePipeline helpers. Sourced by other runtime scripts.
# 100% service-agnostic — all names come from env (SERVICE_NAME, STAGE, …).
set -euo pipefail

: "${SERVICE_NAME:?SERVICE_NAME must be set}"

STAGE="${STAGE:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"

APP_STACK_NAME="${STACK_NAME:-${APP_STACK_NAME:-${STAGE}-${SERVICE_NAME}}}"
DATA_STACK_NAME="${DATA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-data}"
INFRA_STACK_NAME="${INFRA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-infra}"
DATA_TABLE_NAME="${DATA_TABLE_NAME:-${SERVICE_NAME}-${STAGE}}"
DATA_LOGICAL_ID="${DATA_LOGICAL_ID:-PrimaryTable}"
SSM_PREFIX="${SSM_PREFIX:-/${STAGE}/${SERVICE_NAME}}"
LAST_DEPLOYED_COMMIT_PARAM="${LAST_DEPLOYED_COMMIT_PARAM:-/${STAGE}/${SERVICE_NAME}/cicd/LAST_DEPLOYED_COMMIT}"

OWNERSHIP_TAG_SERVICE="${OWNERSHIP_TAG_SERVICE:-${SERVICE_NAME}}"
OWNERSHIP_TAG_PURPOSE="${OWNERSHIP_TAG_PURPOSE:-${DATA_LOGICAL_ID}}"
OWNERSHIP_TAG_MANAGED_BY="${OWNERSHIP_TAG_MANAGED_BY:-serverless}"

# Resolve the service directory that owns packaged templates (data/, infrastructure/, serverless.yml).
# Prefer an explicit SERVICE_DIR / SERVICE_ROOT. Otherwise derive from CI_PATH
# (CodeBuild sets CI_PATH to the service CI directory — service root is its parent).
# Do not fall back to CODEBUILD_SRC_DIR first: that is the repository root, and
# publish-artifacts.sh would then look for data/packaged.yaml in the wrong place.
_resolve_service_root_from_ci_path() {
  local ci_path="${CI_PATH:-${CiPath:-}}"
  local ci_abs=""
  ci_path="${ci_path%/}"
  [ -z "$ci_path" ] && return 1

  if [[ "$ci_path" = /* ]] && [ -d "$ci_path" ]; then
    ci_abs="$ci_path"
  elif [ -n "${CODEBUILD_SRC_DIR:-}" ] && [ -d "${CODEBUILD_SRC_DIR}/${ci_path}" ]; then
    ci_abs="${CODEBUILD_SRC_DIR}/${ci_path}"
  elif [ -d "$ci_path" ]; then
    ci_abs="$(cd "$ci_path" && pwd)"
  else
    return 1
  fi

  cd "${ci_abs}/.." && pwd
}

if [ -z "${SERVICE_ROOT:-}" ] && [ -n "${SERVICE_DIR:-}" ]; then
  SERVICE_ROOT="$SERVICE_DIR"
fi
if [ -z "${SERVICE_ROOT:-}" ]; then
  SERVICE_ROOT="$(_resolve_service_root_from_ci_path || true)"
fi
if [ -z "${SERVICE_ROOT:-}" ]; then
  if [ -n "${CODEBUILD_SRC_DIR:-}" ] && [ -d "${CODEBUILD_SRC_DIR}/apps/${SERVICE_NAME}" ]; then
    SERVICE_ROOT="${CODEBUILD_SRC_DIR}/apps/${SERVICE_NAME}"
  elif [ -n "${CODEBUILD_SRC_DIR:-}" ] && [ -d "${CODEBUILD_SRC_DIR}" ]; then
    SERVICE_ROOT="${CODEBUILD_SRC_DIR}"
  else
    SERVICE_ROOT="$(pwd)"
  fi
fi
SERVICE_DIR="${SERVICE_DIR:-$SERVICE_ROOT}"
unset -f _resolve_service_root_from_ci_path

# Comma-separated list → bash array. Empty → empty array (validate-ssm may warn/skip).
REQUIRED_SSM_PARAMS=()
if [ -n "${REQUIRED_SSM_PARAMETERS:-}" ]; then
  IFS=',' read -r -a REQUIRED_SSM_PARAMS <<< "${REQUIRED_SSM_PARAMETERS}"
  # Trim whitespace around each entry
  _tmp=()
  for _p in "${REQUIRED_SSM_PARAMS[@]}"; do
    _p="${_p#"${_p%%[![:space:]]*}"}"
    _p="${_p%"${_p##*[![:space:]]}"}"
    [ -n "$_p" ] && _tmp+=("$_p")
  done
  REQUIRED_SSM_PARAMS=("${_tmp[@]+"${_tmp[@]}"}")
  unset _tmp _p
fi

# Data contract SSM keys validated after recovery UPDATE (subset of required).
DATA_CONTRACT_SSM_PARAMS=()
if [ -n "${DATA_CONTRACT_SSM_PARAMETERS:-}" ]; then
  IFS=',' read -r -a DATA_CONTRACT_SSM_PARAMS <<< "${DATA_CONTRACT_SSM_PARAMETERS}"
else
  DATA_CONTRACT_SSM_PARAMS=(TABLE_NAME TABLE_ARN STREAM_ARN)
fi

assert_stage() {
  case "${STAGE:-}" in
    dev|stg|prd) ;;
    *)
      echo "ERROR: STAGE must be dev, stg, or prd (got: ${STAGE:-unset})"
      exit 1
      ;;
  esac
}

# Catch CodeBuild projects wired to the wrong buildspec (e.g. stg role → dev STAGE).
assert_codebuild_stage_match() {
  local role="${CODEBUILD_BUILD_ARN:-${AWS_ROLE_ARN:-}}"
  local project="${CODEBUILD_PROJECT_NAME:-}"
  local hint="${role}${project}"
  case "$hint" in
    *stg*|*STG*)
      if [ "$STAGE" != "stg" ]; then
        echo "ERROR: STAGING CodeBuild project detected but STAGE=$STAGE."
        echo "Role/project: ${role:-unknown} / ${project:-unknown}"
        exit 1
      fi
      ;;
    *prd*|*PRD*|*prod*|*PROD*)
      if [ "$STAGE" != "prd" ]; then
        echo "ERROR: PRODUCTION CodeBuild project detected but STAGE=$STAGE."
        exit 1
      fi
      ;;
    *dev*|*DEV*)
      if [ "$STAGE" != "dev" ]; then
        echo "ERROR: DEV CodeBuild project detected but STAGE=$STAGE."
        exit 1
      fi
      ;;
  esac
}

is_git_sha() {
  local value="$1"
  case "$value" in
    *[!0-9a-fA-F]*|'')
      return 1
      ;;
  esac
  local len="${#value}"
  if [ "$len" -lt 7 ] || [ "$len" -gt 40 ]; then
    return 1
  fi
  return 0
}

# CodePipeline/CodeBuild often set CODEBUILD_SOURCE_VERSION to an S3 artifact
# ARN/path when the action input is BuildArtifact. That is not a Git SHA.
is_s3_artifact_ref() {
  local value="$1"
  case "$value" in
    arn:aws:s3:*|arn:aws-us-gov:s3:*|arn:aws-cn:s3:*|s3://*)
      return 0
      ;;
  esac
  case "$value" in
    *BuildArtif*|*SourceArtif*|*codepipeline*)
      return 0
      ;;
  esac
  return 1
}

# Authoritative CI/CD artifact bucket. Supplied by CodePipeline as
# ARTIFACT_BUCKET=#{variables.ArtifactBucket}. Do not derive from STAGE.
environment_artifact_bucket() {
  : "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
  printf '%s' "$ARTIFACT_BUCKET"
}

environment_artifact_prefix() {
  local sha="${1:-${CURRENT_COMMIT:-}}"

  if [ -z "$sha" ]; then
    echo "ERROR: CURRENT_COMMIT is required for the environment artifact prefix" >&2
    return 1
  fi

  printf '%s' "${SERVICE_NAME}/${sha}"
}

# Prefix for CloudFormation deploy --s3-bucket uploads (large template body).
# Distinct from the immutable packaged.yaml keys.
cfn_template_upload_prefix() {
  local layer="$1"
  case "$layer" in
    data|infra|app) ;;
    *)
      echo "ERROR: CloudFormation upload layer must be data, infra, or app (got: ${layer:-unset})" >&2
      return 1
      ;;
  esac
  if [ -n "${CURRENT_COMMIT:-}" ]; then
    printf '%s' "$(environment_artifact_prefix "$CURRENT_COMMIT")/cfn-${layer}"
  else
    printf '%s' "${SERVICE_NAME}/manual/${STAGE}/cfn-${layer}"
  fi
}

# s3://$ARTIFACT_BUCKET/<SERVICE_NAME>/<CURRENT_COMMIT>/<layer>/packaged.yaml
immutable_packaged_template_s3_uri() {
  local layer="$1"
  local bucket prefix

  case "$layer" in
    data|infra|app) ;;
    *)
      echo "ERROR: artifact layer must be data, infra, or app (got: ${layer:-unset})" >&2
      return 1
      ;;
  esac

  bucket="$(environment_artifact_bucket)"
  prefix="$(environment_artifact_prefix "${CURRENT_COMMIT:-}")"
  printf 's3://%s/%s/%s/packaged.yaml' "$bucket" "$prefix" "$layer"
}

# Download the exact packaged template published by Build for this commit.
# When CURRENT_COMMIT is set (pipeline), S3 is required — do not silently use a
# local/BuildArtifact copy. Manual/emergency runs without CURRENT_COMMIT keep
# the local template produced by the service build.sh.
# Returns 1 on fetch failure so callers can fail closed.
fetch_immutable_packaged_template() {
  local layer="$1"
  local dest="$2"
  local uri

  case "$layer" in
    data|infra|app) ;;
    *)
      echo "ERROR: artifact layer must be data, infra, or app (got: ${layer:-unset})" >&2
      return 1
      ;;
  esac

  if [ -z "${CURRENT_COMMIT:-}" ]; then
    return 0
  fi

  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    echo "ERROR: CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path." >&2
    echo "CURRENT_COMMIT=${CURRENT_COMMIT}" >&2
    echo "CODEBUILD_SOURCE_VERSION=${CODEBUILD_SOURCE_VERSION:-<unset>}" >&2
    echo "Do not treat CODEBUILD_SOURCE_VERSION as a Git SHA unless it is actually a Git SHA." >&2
    return 1
  fi

  if ! uri="$(immutable_packaged_template_s3_uri "$layer")"; then
    return 1
  fi

  echo "Fetching immutable ${layer} artifact ${uri}"
  if ! aws s3 cp "$uri" "$dest"; then
    echo "ERROR: Failed to download ${uri}" >&2
    echo "Build must publish ${SERVICE_NAME}/${CURRENT_COMMIT}/${layer}/packaged.yaml" >&2
    echo "Do not fall back to a local packaged.yaml when CURRENT_COMMIT is set." >&2
    return 1
  fi
}

upload_environment_artifact() {
  local local_path="$1"
  local key="$2"
  local bucket

  bucket="$(environment_artifact_bucket)"

  echo "Publishing $local_path → s3://${bucket}/${key} (SSE-S3 AES256)"

  if aws s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>&1; then
    echo "ERROR: Refusing to overwrite existing artifact s3://${bucket}/${key}" >&2
    exit 1
  fi

  if ! aws s3 cp "$local_path" "s3://${bucket}/${key}" --sse AES256; then
    echo "ERROR: Failed to upload s3://${bucket}/${key}" >&2
    aws sts get-caller-identity || true
    exit 1
  fi
}

# Local path for deployment-data-preflight.env.
resolve_data_preflight_env() {
  local candidate="${DATA_PREFLIGHT_ENV:-deployment-data-preflight.env}"
  local src_root="${CODEBUILD_SRC_DIR:-}"

  case "$candidate" in
    /*)
      printf '%s' "$candidate"
      return 0
      ;;
  esac

  if [ -n "$src_root" ]; then
    printf '%s' "$src_root/$candidate"
    return 0
  fi

  if [ -n "${SERVICE_DIR:-}" ] && [ "$candidate" = "deployment-data-preflight.env" ]; then
    printf '%s' "$SERVICE_DIR/deployment-data-preflight.env"
    return 0
  fi

  printf '%s' "$candidate"
}

resolve_data_recovery_env() {
  local candidate="${DATA_RECOVERY_ENV:-deployment-data-recovery.env}"
  local src_root="${CODEBUILD_SRC_DIR:-}"

  case "$candidate" in
    /*)
      printf '%s' "$candidate"
      return 0
      ;;
  esac

  if [ -n "$src_root" ]; then
    printf '%s' "$src_root/$candidate"
    return 0
  fi

  if [ -n "${SERVICE_DIR:-}" ] && [ "$candidate" = "deployment-data-recovery.env" ]; then
    printf '%s' "$SERVICE_DIR/deployment-data-recovery.env"
    return 0
  fi

  printf '%s' "$candidate"
}

resolve_data_recovery_result_env() {
  local candidate="${DATA_RECOVERY_RESULT_ENV:-deployment-data-recovery-result.env}"
  local src_root="${CODEBUILD_SRC_DIR:-}"

  case "$candidate" in
    /*)
      printf '%s' "$candidate"
      return 0
      ;;
  esac

  if [ -n "$src_root" ]; then
    printf '%s' "$src_root/$candidate"
    return 0
  fi

  if [ -n "${SERVICE_DIR:-}" ] && [ "$candidate" = "deployment-data-recovery-result.env" ]; then
    printf '%s' "$SERVICE_DIR/deployment-data-recovery-result.env"
    return 0
  fi

  printf '%s' "$candidate"
}

# Write KEY=value lines that can be sourced by promote-exported-variables.sh.
# Values are shell-escaped so DATA_REASON and similar can contain spaces.
write_sourcable_env() {
  local dest="$1"
  shift
  local key tmp dir
  [ -n "$dest" ] || {
    echo "ERROR: write_sourcable_env requires a destination path" >&2
    return 1
  }
  [ "$#" -gt 0 ] || {
    echo "ERROR: write_sourcable_env requires at least one variable name" >&2
    return 1
  }
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  tmp="$(mktemp "${TMPDIR:-/tmp}/exported-env.XXXXXX")"
  for key in "$@"; do
    case "$key" in
      [A-Za-z_]*) ;;
      *)
        echo "ERROR: write_sourcable_env: invalid variable name: $key" >&2
        rm -f "$tmp"
        return 1
        ;;
    esac
    case "$key" in
      *[!A-Za-z0-9_]*)
        echo "ERROR: write_sourcable_env: invalid variable name: $key" >&2
        rm -f "$tmp"
        return 1
        ;;
    esac
    local value=""
    eval "value=\"\${${key}-}\""
    printf '%s=%q\n' "$key" "$value" >>"$tmp"
  done
  mv "$tmp" "$dest"
  echo "Wrote $dest"
}

resolve_deployment_manifest_dest() {
  local candidate="${DEPLOYMENT_MANIFEST:-deployment-manifest.json}"
  local src_root="${CODEBUILD_SRC_DIR:-}"

  case "$candidate" in
    /*)
      printf '%s' "$candidate"
      return 0
      ;;
  esac

  if [ -n "$src_root" ]; then
    printf '%s' "$src_root/$candidate"
    return 0
  fi

  if [ -n "${SERVICE_DIR:-}" ] && [ "$candidate" = "deployment-manifest.json" ]; then
    printf '%s' "$SERVICE_DIR/deployment-manifest.json"
    return 0
  fi

  printf '%s' "$candidate"
}

# Build/package writes this file. Change detection must not.
generate_deployment_manifest() {
  local dest bucket prefix
  : "${STAGE:?STAGE must be set (dev, stg, or prd)}"
  : "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET must be set}"
  : "${CURRENT_COMMIT:?CURRENT_COMMIT must be set to a Git commit SHA}"
  : "${DEPLOY_DATA:?DEPLOY_DATA must be set (true or false)}"
  : "${DEPLOY_INFRA:?DEPLOY_INFRA must be set (true or false)}"
  : "${DEPLOY_APP:?DEPLOY_APP must be set (true or false)}"

  case "$DEPLOY_DATA" in
    true|false) ;;
    *)
      echo "ERROR: DEPLOY_DATA must be true or false (got: $DEPLOY_DATA)" >&2
      return 1
      ;;
  esac
  case "$DEPLOY_INFRA" in
    true|false) ;;
    *)
      echo "ERROR: DEPLOY_INFRA must be true or false (got: $DEPLOY_INFRA)" >&2
      return 1
      ;;
  esac
  case "$DEPLOY_APP" in
    true|false) ;;
    *)
      echo "ERROR: DEPLOY_APP must be true or false (got: $DEPLOY_APP)" >&2
      return 1
      ;;
  esac

  if is_s3_artifact_ref "$CURRENT_COMMIT" || ! is_git_sha "$CURRENT_COMMIT"; then
    echo "ERROR: CURRENT_COMMIT must be a Git commit SHA, not an S3 artifact ARN/path." >&2
    echo "CURRENT_COMMIT=$CURRENT_COMMIT" >&2
    echo "CODEBUILD_SOURCE_VERSION=${CODEBUILD_SOURCE_VERSION:-<unset>}" >&2
    echo "Do not treat CODEBUILD_SOURCE_VERSION as a Git SHA unless it is actually a Git SHA." >&2
    return 1
  fi

  dest="$(resolve_deployment_manifest_dest)"
  mkdir -p "$(dirname "$dest")"
  bucket="$(environment_artifact_bucket)"
  prefix="$(environment_artifact_prefix "$CURRENT_COMMIT")"

  cat >"$dest" <<EOF
{
  "service": "${SERVICE_NAME}",
  "stage": "$STAGE",
  "currentCommit": "$CURRENT_COMMIT",
  "artifactBucket": "$bucket",
  "artifactPrefix": "$prefix",
  "deployData": $DEPLOY_DATA,
  "deployInfra": $DEPLOY_INFRA,
  "deployApp": $DEPLOY_APP,
  "DEPLOY_DATA": $DEPLOY_DATA,
  "DEPLOY_INFRA": $DEPLOY_INFRA,
  "DEPLOY_APP": $DEPLOY_APP
}
EOF

  echo "Wrote deployment manifest: $dest"
  echo "  currentCommit=$CURRENT_COMMIT"
  echo "  artifactBucket=$bucket"
  echo "  artifactPrefix=$prefix"
}

# CloudFormation service role for Data recovery IMPORT / post-import SSM restore.
cfn_data_recovery_role_args() {
  local role="${CFN_RECOVER_ROLE_ARN:-}"
  if [ -z "$role" ]; then
    return 0
  fi
  echo "--role-arn"
  echo "$role"
}

cfn_deploy_role_args() {
  local role="${CFN_DEPLOY_ROLE_ARN:-}"
  if [ -z "$role" ]; then
    return 0
  fi
  echo "--role-arn"
  echo "$role"
}

# Assume the dedicated Data recovery CodeBuild role when configured.
assume_data_recovery_role_if_configured() {
  local creds access_key secret_key session_token

  if [ -z "${RECOVER_DATA_ROLE_ARN:-}" ]; then
    return 0
  fi
  if [ "${DATA_RECOVERY_ROLE_ASSUMED:-}" = "1" ]; then
    return 0
  fi

  echo "Assuming Data recovery role ${RECOVER_DATA_ROLE_ARN}"
  creds="$(aws sts assume-role \
    --role-arn "$RECOVER_DATA_ROLE_ARN" \
    --role-session-name "${SERVICE_NAME}-data-recovery" \
    --duration-seconds 3600 \
    --output json)" || {
    echo "ERROR: Failed to assume Data recovery role ${RECOVER_DATA_ROLE_ARN}"
    return 1
  }

  access_key="$(CREDS="$creds" node -e 'process.stdout.write(JSON.parse(process.env.CREDS).Credentials.AccessKeyId || "")')"
  secret_key="$(CREDS="$creds" node -e 'process.stdout.write(JSON.parse(process.env.CREDS).Credentials.SecretAccessKey || "")')"
  session_token="$(CREDS="$creds" node -e 'process.stdout.write(JSON.parse(process.env.CREDS).Credentials.SessionToken || "")')"

  if [ -z "$access_key" ] || [ -z "$secret_key" ] || [ -z "$session_token" ]; then
    echo "ERROR: assume-role did not return credentials for ${RECOVER_DATA_ROLE_ARN}"
    return 1
  fi

  export AWS_ACCESS_KEY_ID="$access_key"
  export AWS_SECRET_ACCESS_KEY="$secret_key"
  export AWS_SESSION_TOKEN="$session_token"
  export DATA_RECOVERY_ROLE_ASSUMED=1
}

# Normalize ENABLE_* / DEPLOY_* to true|false.
normalize_bool() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES) printf 'true' ;;
    false|FALSE|False|0|no|NO|'') printf 'false' ;;
    *)
      echo "ERROR: expected boolean true/false, got: $1" >&2
      return 1
      ;;
  esac
}

export SERVICE_NAME STAGE AWS_REGION
export APP_STACK_NAME STACK_NAME="${STACK_NAME:-$APP_STACK_NAME}"
export DATA_STACK_NAME INFRA_STACK_NAME DATA_TABLE_NAME DATA_LOGICAL_ID
export SSM_PREFIX LAST_DEPLOYED_COMMIT_PARAM
export OWNERSHIP_TAG_SERVICE OWNERSHIP_TAG_PURPOSE OWNERSHIP_TAG_MANAGED_BY
export SERVICE_ROOT SERVICE_DIR
