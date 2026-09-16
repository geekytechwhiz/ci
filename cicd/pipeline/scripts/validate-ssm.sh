#!/bin/bash
# SSM cross-stack contract gate (service-agnostic).
#
# Contract:
#   ENABLE_SSM_VALIDATION=false → skip intentionally
#   ENABLE_SSM_VALIDATION=true  + REQUIRED_SSM_PARAMETERS empty → FAIL
#   ENABLE_SSM_VALIDATION=true  + parameters configured → validate
#
# REQUIRED_SSM_PARAMETERS is a comma-separated list of leaf names only
# (example TABLE_NAME,TABLE_ARN,STREAM_ARN). Full paths are rejected.
# Each checked name is ${SSM_PREFIX}/${leaf}.
#
# SSM_PREFIX must be supplied by the pipeline from the service SSM contract.
# This script does not invent /${STAGE}/${SERVICE_NAME}.

set -euo pipefail

trim() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

normalize_ssm_prefix() {
  local prefix
  prefix="$(trim "${1:-}")"
  prefix="${prefix%/}"
  printf '%s' "$prefix"
}

is_valid_ssm_prefix() {
  local prefix="$1"
  [[ "$prefix" =~ ^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$ ]]
}

is_valid_ssm_leaf() {
  local leaf="$1"
  [[ "$leaf" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]
}

caller_identity() {
  local ident=""
  ident="$(aws sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null || true)"
  ident="$(trim "$ident")"
  if [ -z "$ident" ]; then
    printf 'unknown'
  else
    printf '%s' "$ident"
  fi
}

report_ssm_error() {
  local name="$1"
  local reason="$2"
  local aws_err="${3:-}"
  echo "[SSM] ERROR" >&2
  echo "Parameter: ${name}" >&2
  echo "Region: ${AWS_REGION}" >&2
  echo "Prefix: ${SSM_PREFIX}" >&2
  echo "AWS account/caller: $(caller_identity)" >&2
  echo "Reason: ${reason}" >&2
  if [ -n "$aws_err" ]; then
    echo "AWS CLI error:" >&2
    echo "$aws_err" >&2
  fi
}

load_expected_value() {
  local leaf="$1"
  local expected=""

  if [ -n "${DATA_TABLE_NAME:-}" ] && [ "$leaf" = "TABLE_NAME" ]; then
    expected="$DATA_TABLE_NAME"
  fi

  if [ -z "${SSM_EXPECTED_VALUES_FILE:-}" ]; then
    printf '%s' "$expected"
    return 0
  fi

  local file="$SSM_EXPECTED_VALUES_FILE"
  if [ ! -f "$file" ] && [ -n "${CODEBUILD_SRC_DIR:-}" ] && [ -f "${CODEBUILD_SRC_DIR}/${file}" ]; then
    file="${CODEBUILD_SRC_DIR}/${file}"
  fi
  if [ ! -f "$file" ]; then
    echo "[SSM] ERROR SSM_EXPECTED_VALUES_FILE is set but not found: ${SSM_EXPECTED_VALUES_FILE}" >&2
    return 2
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "[SSM] ERROR python3 is required to read SSM_EXPECTED_VALUES_FILE" >&2
    return 2
  fi

  local from_file=""
  from_file="$(python3 - "$file" "$leaf" <<'PY'
import json, sys
path, leaf = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    raise SystemExit("expected a JSON object of leaf -> value")
value = data.get(leaf)
if value is None:
    print("")
else:
    print(value, end="")
PY
)"
  if [ -n "$from_file" ]; then
    expected="$from_file"
  fi
  printf '%s' "$expected"
}

parse_required_leaves() {
  local raw="$1"
  local -a parsed=()
  local leaf seen=""

  IFS=',' read -r -a parsed <<< "$raw" || true

  REQUIRED_SSM_LEAVES=()
  for leaf in "${parsed[@]+"${parsed[@]}"}"; do
    leaf="$(trim "$leaf")"
    if [ -z "$leaf" ]; then
      continue
    fi
    if [[ "$leaf" == /* ]] || [[ "$leaf" == */* ]]; then
      echo "[SSM] ERROR malformed parameter path: '${leaf}'" >&2
      echo "[SSM] RequiredSsmParameters must be leaf names only (example TABLE_NAME), not full SSM paths." >&2
      echo "[SSM] Prefix: ${SSM_PREFIX:-<unset>}" >&2
      return 1
    fi
    if ! is_valid_ssm_leaf "$leaf"; then
      echo "[SSM] ERROR malformed parameter path: '${leaf}'" >&2
      echo "[SSM] Leaf names may contain letters, numbers, underscore, dot, and hyphen only." >&2
      return 1
    fi
    case "$seen" in
      *"|${leaf}|"*)
        echo "[SSM] ERROR duplicate parameter leaf: ${leaf}" >&2
        return 1
        ;;
    esac
    seen="${seen}|${leaf}|"
    REQUIRED_SSM_LEAVES+=("$leaf")
  done

  if [ ${#REQUIRED_SSM_LEAVES[@]} -eq 0 ]; then
    echo "[SSM] ERROR ENABLE_SSM_VALIDATION=true but REQUIRED_SSM_PARAMETERS is empty after parsing." >&2
    return 1
  fi
  return 0
}

get_parameter_value() {
  local name="$1"
  local err_file out rc=0
  err_file="$(mktemp /tmp/ssm-get-parameter.XXXXXX)"
  out="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$name" \
    --query 'Parameter.Value' \
    --output text 2>"$err_file")" || rc=$?
  GET_PARAMETER_ERROR="$(cat "$err_file" 2>/dev/null || true)"
  GET_PARAMETER_RC="$rc"
  rm -f "$err_file"
  printf '%s' "$out"
}

echo "[SSM] Validation started"

ENABLE_SSM_VALIDATION="$(trim "${ENABLE_SSM_VALIDATION:-true}")"
case "$ENABLE_SSM_VALIDATION" in
  true|false) ;;
  *)
    echo "[SSM] ERROR ENABLE_SSM_VALIDATION must be true or false (got: ${ENABLE_SSM_VALIDATION})" >&2
    exit 1
    ;;
esac

if [ "$ENABLE_SSM_VALIDATION" = "false" ]; then
  echo "[SSM] ENABLE_SSM_VALIDATION=false; validation skipped intentionally."
  echo "[SSM] Validation SKIPPED"
  exit 0
fi

AWS_REGION="$(trim "${AWS_REGION:-}")"
SSM_PREFIX="$(normalize_ssm_prefix "${SSM_PREFIX:-}")"
REQUIRED_SSM_PARAMETERS="$(trim "${REQUIRED_SSM_PARAMETERS:-}")"

if [ -z "$AWS_REGION" ]; then
  echo "[SSM] ERROR AWS_REGION is missing." >&2
  exit 1
fi

if [ -z "$SSM_PREFIX" ]; then
  echo "[SSM] ERROR SSM_PREFIX is missing." >&2
  echo "[SSM] The pipeline must supply the service SSM contract prefix as deployment context." >&2
  echo "[SSM] Do not invent /{Stage}/{ServiceName}." >&2
  exit 1
fi

if ! is_valid_ssm_prefix "$SSM_PREFIX"; then
  echo "[SSM] ERROR malformed SSM_PREFIX: '${SSM_PREFIX}'" >&2
  echo "[SSM] Prefix must start with / and must not contain a trailing or double slash." >&2
  exit 1
fi

if [ -z "$REQUIRED_SSM_PARAMETERS" ]; then
  echo "[SSM] ERROR ENABLE_SSM_VALIDATION=true but REQUIRED_SSM_PARAMETERS is empty." >&2
  echo "[SSM] Configure RequiredSsmParameters (leaf names) or set ENABLE_SSM_VALIDATION=false." >&2
  exit 1
fi

REQUIRED_SSM_LEAVES=()
parse_required_leaves "$REQUIRED_SSM_PARAMETERS"

joined="$(IFS=','; echo "${REQUIRED_SSM_LEAVES[*]}")"
echo "[SSM] Region: ${AWS_REGION}"
echo "[SSM] Prefix: ${SSM_PREFIX}"
echo "[SSM] Required parameters: ${joined}"
echo "[SSM] SERVICE_NAME=${SERVICE_NAME:-<unset>} STAGE=${STAGE:-<unset>}"

failed=0
for leaf in "${REQUIRED_SSM_LEAVES[@]}"; do
  name="${SSM_PREFIX}/${leaf}"
  if [[ "$name" == *//* ]]; then
    echo "[SSM] ERROR malformed parameter path: '${name}'" >&2
    echo "[SSM] Accidental double slash. Check SSM_PREFIX and leaf names." >&2
    failed=1
    continue
  fi

  expected=""
  expected="$(load_expected_value "$leaf")" || exit $?

  GET_PARAMETER_ERROR=""
  GET_PARAMETER_RC=0
  value="$(get_parameter_value "$name")"

  if [ "$GET_PARAMETER_RC" -ne 0 ]; then
    reason="AWS CLI exited ${GET_PARAMETER_RC}"
    if echo "$GET_PARAMETER_ERROR" | grep -qi 'AccessDenied'; then
      reason="AccessDenied"
    elif echo "$GET_PARAMETER_ERROR" | grep -qi 'ParameterNotFound'; then
      reason="ParameterNotFound (wrong prefix, name, or region ${AWS_REGION})"
    fi
    report_ssm_error "$name" "$reason" "$GET_PARAMETER_ERROR"
    failed=1
    continue
  fi

  if [ -z "$value" ] || [ "$value" = "None" ]; then
    report_ssm_error "$name" "parameter exists but value is empty"
    failed=1
    continue
  fi

  if [ -n "$expected" ] && [ "$value" != "$expected" ]; then
    report_ssm_error "$name" "actual value does not match expected deployed contract for ${leaf}"
    echo "[SSM] Expected length: ${#expected}; actual length: ${#value}" >&2
    failed=1
    continue
  fi

  echo "[SSM] present: ${name}"
done

if [ "$failed" -ne 0 ]; then
  echo "[SSM] Validation FAILED" >&2
  exit 1
fi

echo "[SSM] Validation PASSED"
exit 0
