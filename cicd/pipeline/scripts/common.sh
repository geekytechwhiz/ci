#!/bin/bash
# Generic CodePipeline helpers. Sourced by other runtime scripts.
# Stack names may come from env (SERVICE_NAME, STAGE). DynamoDB TableName and
# logical ID come from the service Data packaged template — never invent
# ${SERVICE_NAME}-${STAGE} or prefix an explicit service resource name.
set -euo pipefail

: "${SERVICE_NAME:?SERVICE_NAME must be set}"

STAGE="${STAGE:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"

APP_STACK_NAME="${STACK_NAME:-${APP_STACK_NAME:-${STAGE}-${SERVICE_NAME}}}"
DATA_STACK_NAME="${DATA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-data}"
INFRA_STACK_NAME="${INFRA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-infra}"
DATA_TABLE_NAME="${DATA_TABLE_NAME:-}"
DATA_LOGICAL_ID="${DATA_LOGICAL_ID:-}"
RESOURCE_NAME_PREFIX="${RESOURCE_NAME_PREFIX:-}"
if [ -z "${SSM_PREFIX:-}" ]; then
  if [ -n "${RESOURCE_NAME_PREFIX}" ]; then
    SSM_PREFIX="/${RESOURCE_NAME_PREFIX}/${SERVICE_NAME}"
  else
    SSM_PREFIX="/${STAGE}/${SERVICE_NAME}"
  fi
fi
LAST_DEPLOYED_COMMIT_PARAM="${LAST_DEPLOYED_COMMIT_PARAM:-/${STAGE}/${SERVICE_NAME}/cicd/LAST_DEPLOYED_COMMIT}"

# Ownership identity is filled from the service Data packaged template.
# Pipeline/env OWNERSHIP_TAG_* values are hints only and are overwritten.
OWNERSHIP_TAG_SERVICE="${OWNERSHIP_TAG_SERVICE:-}"
OWNERSHIP_TAG_PURPOSE="${OWNERSHIP_TAG_PURPOSE:-}"
OWNERSHIP_TAG_MANAGED_BY="${OWNERSHIP_TAG_MANAGED_BY:-}"
OWNERSHIP_TAG_STAGE="${OWNERSHIP_TAG_STAGE:-}"

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

# Stable local path so Preflight and Deploy use the same downloaded bytes.
immutable_packaged_template_local_path() {
  local layer="$1"
  local root

  case "$layer" in
    data|infra|app) ;;
    *)
      echo "ERROR: artifact layer must be data, infra, or app (got: ${layer:-unset})" >&2
      return 1
      ;;
  esac

  if [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
    root="${CODEBUILD_SRC_DIR}"
  else
    root="${TMPDIR:-/tmp}"
  fi

  if [ -n "${CURRENT_COMMIT:-}" ]; then
    printf '%s' "${root}/.pipeline-immutable/${SERVICE_NAME}/${CURRENT_COMMIT}/${layer}/packaged.yaml"
  else
    printf '%s' "${root}/.pipeline-immutable/${SERVICE_NAME}/local/${layer}/packaged.yaml"
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  elif command -v node >/dev/null 2>&1; then
    SHA_FILE="$file" node -e 'const fs=require("fs"); const crypto=require("crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.env.SHA_FILE)).digest("hex"));'
  else
    echo "ERROR: No sha256 tool available (sha256sum, shasum, openssl, or node)." >&2
    return 1
  fi
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
  mkdir -p "$(dirname "$dest")"
  if ! aws s3 cp "$uri" "$dest"; then
    echo "ERROR: Failed to download ${uri}" >&2
    echo "Build must publish ${SERVICE_NAME}/${CURRENT_COMMIT}/${layer}/packaged.yaml" >&2
    echo "Do not fall back to a local packaged.yaml when CURRENT_COMMIT is set." >&2
    return 1
  fi
}

# Resolve DynamoDB logical ID, physical TableName, and identity tags from the
# service Data packaged template. Does not invent names or tags, and does not
# rewrite TableName with ResourceNamePrefix.
apply_data_resource_identity_from_template() {
  local template_path="${1:-}"
  local resolved hint_logical hint_table hint_service hint_purpose hint_managed
  local logical_id table_name tag_service tag_stage tag_purpose tag_managed

  if [ -z "$template_path" ] || [ ! -s "$template_path" ]; then
    echo "ERROR: Data packaged template is required to resolve the DynamoDB table identity." >&2
    return 1
  fi

  hint_logical="${DATA_LOGICAL_ID:-}"
  hint_table="${DATA_TABLE_NAME:-}"
  hint_service="${OWNERSHIP_TAG_SERVICE:-}"
  hint_purpose="${OWNERSHIP_TAG_PURPOSE:-}"
  hint_managed="${OWNERSHIP_TAG_MANAGED_BY:-}"

  resolved="$(
    TEMPLATE_PATH="$template_path" \
    HINT_LOGICAL_ID="$hint_logical" \
    node <<'NODE'
const fs = require('fs');
const path = process.env.TEMPLATE_PATH;
const hintLogical = (process.env.HINT_LOGICAL_ID || '').trim();
let template;
try {
  template = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {
  console.error('ERROR: Data packaged template is not JSON: ' + e.message);
  process.exit(1);
}
const resources = template.Resources || {};
const tables = [];
for (const [id, res] of Object.entries(resources)) {
  if (res && res.Type === 'AWS::DynamoDB::Table') {
    tables.push({ id, res });
  }
}
if (tables.length === 0) {
  console.error('ERROR: Data packaged template has no AWS::DynamoDB::Table resource.');
  process.exit(1);
}

let chosen = null;
if (hintLogical && resources[hintLogical] && resources[hintLogical].Type === 'AWS::DynamoDB::Table') {
  chosen = { id: hintLogical, res: resources[hintLogical] };
} else if (hintLogical) {
  console.error('WARN: DATA_LOGICAL_ID=' + hintLogical + ' is not an AWS::DynamoDB::Table in the Data artifact; using the artifact table instead.');
}
if (!chosen) {
  if (tables.length !== 1) {
    console.error('ERROR: Data packaged template has ' + tables.length + ' DynamoDB tables; set DATA_LOGICAL_ID or provide exactly one table.');
    process.exit(1);
  }
  chosen = tables[0];
}

const props = chosen.res.Properties || {};
const tableName = props.TableName;
if (!tableName || typeof tableName !== 'string' || !tableName.trim()) {
  console.error('ERROR: ' + chosen.id + ' TableName is missing or not a literal string in the Data artifact.');
  process.exit(1);
}
if (tableName.includes('${') || tableName.includes('!Ref') || tableName.includes('Fn::')) {
  console.error('ERROR: ' + chosen.id + ' TableName is unresolved in the Data artifact: ' + tableName);
  process.exit(1);
}

function tagValue(tags, key) {
  if (!Array.isArray(tags)) return '';
  for (const t of tags) {
    if (t && t.Key === key && typeof t.Value === 'string') return t.Value;
  }
  return '';
}

const tags = props.Tags || [];
const identity = {
  logicalId: chosen.id,
  tableName: tableName.trim(),
  service: tagValue(tags, 'Service'),
  stage: tagValue(tags, 'Stage'),
  purpose: tagValue(tags, 'Purpose'),
  managedBy: tagValue(tags, 'ManagedBy'),
};
process.stdout.write(JSON.stringify(identity));
NODE
  )" || return 1

  logical_id="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).logicalId || "")')"
  table_name="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).tableName || "")')"
  tag_service="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).service || "")')"
  tag_stage="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).stage || "")')"
  tag_purpose="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).purpose || "")')"
  tag_managed="$(RESOLVED_JSON="$resolved" node -e 'process.stdout.write(JSON.parse(process.env.RESOLVED_JSON).managedBy || "")')"

  if [ -z "$logical_id" ] || [ -z "$table_name" ]; then
    echo "ERROR: Failed to parse DynamoDB identity from ${template_path}." >&2
    return 1
  fi

  echo "Data resource identity from service artifact ${template_path}:"
  echo "  logicalId=${logical_id}"
  echo "  TableName=${table_name}"
  echo "  tag Service=${tag_service:-<missing>}"
  echo "  tag Stage=${tag_stage:-<missing>}"
  echo "  tag Purpose=${tag_purpose:-<missing>}"
  echo "  tag ManagedBy=${tag_managed:-<missing>}"

  if [ -n "$hint_table" ] && [ "$hint_table" != "$table_name" ]; then
    echo "INFO: Ignoring pipeline/env DATA_TABLE_NAME='${hint_table}'."
    echo "INFO: Service Data artifact TableName='${table_name}' is authoritative."
  fi
  if [ -n "$hint_logical" ] && [ "$hint_logical" != "$logical_id" ]; then
    echo "INFO: Using Data artifact logical ID '${logical_id}' (env had '${hint_logical}')."
  fi
  if [ -n "$hint_service" ] && [ "$hint_service" != "$tag_service" ]; then
    echo "INFO: Ignoring pipeline/env OWNERSHIP_TAG_SERVICE='${hint_service}'."
  fi
  if [ -n "$hint_purpose" ] && [ "$hint_purpose" != "$tag_purpose" ]; then
    echo "INFO: Ignoring pipeline/env OWNERSHIP_TAG_PURPOSE='${hint_purpose}'."
  fi
  if [ -n "$hint_managed" ] && [ "$hint_managed" != "$tag_managed" ]; then
    echo "INFO: Ignoring pipeline/env OWNERSHIP_TAG_MANAGED_BY='${hint_managed}'."
  fi

  DATA_LOGICAL_ID="$logical_id"
  DATA_TABLE_NAME="$table_name"
  OWNERSHIP_TAG_SERVICE="$tag_service"
  OWNERSHIP_TAG_STAGE="$tag_stage"
  OWNERSHIP_TAG_PURPOSE="$tag_purpose"
  OWNERSHIP_TAG_MANAGED_BY="$tag_managed"
  export DATA_LOGICAL_ID DATA_TABLE_NAME
  export OWNERSHIP_TAG_SERVICE OWNERSHIP_TAG_STAGE OWNERSHIP_TAG_PURPOSE OWNERSHIP_TAG_MANAGED_BY
  echo "Using expected DynamoDB identity from packaged.yaml: logicalId=${DATA_LOGICAL_ID} tableName=${DATA_TABLE_NAME} Service=${OWNERSHIP_TAG_SERVICE:-<missing>} Stage=${OWNERSHIP_TAG_STAGE:-<missing>} Purpose=${OWNERSHIP_TAG_PURPOSE:-<missing>} ManagedBy=${OWNERSHIP_TAG_MANAGED_BY:-<missing>}"

  if [ -z "$tag_service" ] || [ -z "$tag_stage" ] || [ -z "$tag_purpose" ] || [ -z "$tag_managed" ]; then
    echo "ERROR: ${logical_id} is missing required identity tags Service, Stage, Purpose, and ManagedBy in the Data artifact." >&2
    echo "ERROR: The generic pipeline will not invent ownership tags." >&2
    return 1
  fi

  if [ -n "${STAGE:-}" ] && [ "$tag_stage" != "$STAGE" ]; then
    echo "ERROR: Artifact tag Stage='${tag_stage}' does not match pipeline STAGE='${STAGE}'." >&2
    echo "ERROR: The generic pipeline will not override the service-generated Stage tag." >&2
    return 1
  fi

  # Service-generated TableName is authoritative, but it must still comply with
  # the environment naming prefix (RESOURCE_NAME_PREFIX, e.g. nvdev-use1-mvx).
  # Do not rewrite the name; fail closed if it does not match.
  if [ -z "${RESOURCE_NAME_PREFIX:-}" ]; then
    if [ -n "${CURRENT_COMMIT:-}" ]; then
      echo "ERROR: RESOURCE_NAME_PREFIX is required to validate the service-generated TableName." >&2
      echo "ERROR: The pipeline must not invent or rewrite DynamoDB table names." >&2
      return 1
    fi
  else
    case "$table_name" in
      "${RESOURCE_NAME_PREFIX}"*)
        ;;
      *)
        echo "ERROR: Artifact TableName '${table_name}' does not start with RESOURCE_NAME_PREFIX='${RESOURCE_NAME_PREFIX}'." >&2
        echo "ERROR: The generic pipeline will not rename the table to satisfy the prefix." >&2
        return 1
        ;;
    esac
  fi
}

# Remove a failed CloudFormation stack record so CREATE/IMPORT can retry.
# DynamoDB DeletionPolicy Retain keeps any physical table; do not DeleteTable.
delete_failed_cfn_stack_record() {
  local stack="$1"
  local status="$2"

  case "$status" in
    ROLLBACK_COMPLETE|CREATE_FAILED|IMPORT_ROLLBACK_COMPLETE|IMPORT_FAILED)
      ;;
    *)
      echo "ERROR: Refusing to delete stack ${stack} in status ${status:-unset}." >&2
      return 1
      ;;
  esac

  echo "Removing failed CloudFormation stack record ${stack} (${status})."
  echo "DeletionPolicy Retain keeps existing DynamoDB tables. Tables are not deleted or recreated."
  aws cloudformation delete-stack \
    --region "$AWS_REGION" \
    --stack-name "$stack"
  if ! aws cloudformation wait stack-delete-complete \
    --region "$AWS_REGION" \
    --stack-name "$stack"; then
    print_cfn_failure_diagnostics "$stack"
    echo "ERROR: Failed to delete the failed stack record ${stack}. DynamoDB was not targeted for deletion." >&2
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

# Print CloudFormation failure reasons into CodeBuild logs.
# Prefers describe-events --filters FailedEvents=true; falls back to stack events.
print_cfn_failure_diagnostics() {
  local stack="${1:-}"
  local region="${AWS_REGION:-}"

  if [ -z "$stack" ]; then
    echo "[CFN-DIAG] No stack name supplied; skipping CloudFormation diagnostics."
    return 0
  fi

  echo "======================================="
  echo "[CFN-DIAG] CloudFormation failure diagnostics"
  echo "[CFN-DIAG] stack=${stack} region=${region:-<default>}"
  echo "======================================="

  echo "[CFN-DIAG] describe-stacks:"
  aws cloudformation describe-stacks \
    ${region:+--region "$region"} \
    --stack-name "$stack" \
    --output json 2>&1 | head -c 20000 || true
  echo

  echo "[CFN-DIAG] failed events (describe-events):"
  if aws cloudformation describe-events \
    ${region:+--region "$region"} \
    --stack-name "$stack" \
    --filters FailedEvents=true \
    --output json >/tmp/cfn-failed-events.json 2>/tmp/cfn-failed-events.err; then
    cat /tmp/cfn-failed-events.json
  else
    echo "[CFN-DIAG] describe-events failed; falling back to describe-stack-events."
    cat /tmp/cfn-failed-events.err || true
    aws cloudformation describe-stack-events \
      ${region:+--region "$region"} \
      --stack-name "$stack" \
      --output json 2>&1 | head -c 40000 || true
  fi
  echo

  echo "[CFN-DIAG] recent stack events:"
  aws cloudformation describe-stack-events \
    ${region:+--region "$region"} \
    --stack-name "$stack" \
    --query 'StackEvents[0:25].[Timestamp,ResourceStatus,LogicalResourceId,ResourceType,ResourceStatusReason]' \
    --output table 2>&1 || true
  echo "======================================="
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
export OWNERSHIP_TAG_SERVICE OWNERSHIP_TAG_STAGE OWNERSHIP_TAG_PURPOSE OWNERSHIP_TAG_MANAGED_BY
export RESOURCE_NAME_PREFIX
export SERVICE_ROOT SERVICE_DIR
