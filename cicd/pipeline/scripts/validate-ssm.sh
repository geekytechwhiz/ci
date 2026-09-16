#!/bin/bash
# SSM cross-stack contract gate (service-agnostic).
#
# Contract:
#   ENABLE_SSM_VALIDATION unset or false → skip intentionally (default false)
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

  # Optional service-supplied JSON object of leaf -> expected value.
  # Generic CI/CD does not invent TABLE_NAME or other service-specific leaves.
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
  local -a tokens=()
  local leaf seen="" end i idx

  IFS=',' read -r -a parsed <<< "$raw" || true

  for leaf in "${parsed[@]+"${parsed[@]}"}"; do
    tokens+=("$(trim "$leaf")")
  done

  # CloudFormation AllowedPattern permits a trailing comma. Strip only trailing
  # empty tokens; a middle empty token (TABLE_NAME,,STREAM_ARN) is an error.
  end=${#tokens[@]}
  while [ "$end" -gt 0 ]; do
    idx=$((end - 1))
    if [ -n "${tokens[$idx]}" ]; then
      break
    fi
    end="$idx"
  done

  REQUIRED_SSM_LEAVES=()
  for ((i = 0; i < end; i++)); do
    leaf="${tokens[$i]}"
    if [ -z "$leaf" ]; then
      echo "[SSM] ERROR empty parameter leaf in RequiredSsmParameters." >&2
      echo "[SSM] Empty leaf names are not allowed (example TABLE_NAME,,STREAM_ARN)." >&2
      return 1
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

# Batch GetParameters (max 10 names per call). Do not convert AccessDenied into
# ParameterNotFound. InvalidParameters are the only "missing" names.
fetch_ssm_parameters() {
  local err_file out rc=0
  GET_PARAMETERS_ERROR=""
  GET_PARAMETERS_RC=0
  GET_PARAMETERS_JSON=""
  err_file="$(mktemp /tmp/ssm-get-parameters.XXXXXX)"
  out="$(aws ssm get-parameters \
    --region "$AWS_REGION" \
    --names "$@" \
    --output json 2>"$err_file")" || rc=$?
  GET_PARAMETERS_ERROR="$(cat "$err_file" 2>/dev/null || true)"
  GET_PARAMETERS_RC="$rc"
  GET_PARAMETERS_JSON="$out"
  rm -f "$err_file"
}

echo "[SSM] Validation started"

ENABLE_SSM_VALIDATION="$(trim "${ENABLE_SSM_VALIDATION:-false}")"
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
declare -a REQUIRED_SSM_NAMES=()
for leaf in "${REQUIRED_SSM_LEAVES[@]}"; do
  name="${SSM_PREFIX}/${leaf}"
  if [[ "$name" == *//* ]]; then
    echo "[SSM] ERROR malformed parameter path: '${name}'" >&2
    echo "[SSM] Accidental double slash. Check SSM_PREFIX and leaf names." >&2
    failed=1
    continue
  fi
  REQUIRED_SSM_NAMES+=("$name")
done

if [ "$failed" -eq 0 ] && [ ${#REQUIRED_SSM_NAMES[@]} -gt 0 ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[SSM] ERROR python3 is required to parse get-parameters output." >&2
    exit 2
  fi

  chunk_size=10
  offset=0
  while [ "$offset" -lt ${#REQUIRED_SSM_NAMES[@]} ]; do
    chunk=()
    i=0
    while [ "$i" -lt "$chunk_size" ] && [ $((offset + i)) -lt ${#REQUIRED_SSM_NAMES[@]} ]; do
      chunk+=("${REQUIRED_SSM_NAMES[$((offset + i))]}")
      i=$((i + 1))
    done
    offset=$((offset + ${#chunk[@]}))

    fetch_ssm_parameters "${chunk[@]}"
    if [ "$GET_PARAMETERS_RC" -ne 0 ]; then
      reason="AWS CLI exited ${GET_PARAMETERS_RC}"
      if echo "$GET_PARAMETERS_ERROR" | grep -qi 'AccessDenied'; then
        reason="AccessDenied"
      elif echo "$GET_PARAMETERS_ERROR" | grep -qi 'ParameterNotFound'; then
        reason="ParameterNotFound (wrong prefix, name, or region ${AWS_REGION})"
      fi
      for name in "${chunk[@]}"; do
        report_ssm_error "$name" "$reason" "$GET_PARAMETERS_ERROR"
      done
      failed=1
      continue
    fi

    chunk_report="$(
      GET_PARAMETERS_JSON="$GET_PARAMETERS_JSON" python3 - "${chunk[@]}" <<'PY'
import json, os, sys
data = json.loads(os.environ.get("GET_PARAMETERS_JSON") or "{}")
found = {p.get("Name"): (p.get("Value") if p.get("Value") is not None else "") for p in (data.get("Parameters") or []) if p.get("Name")}
invalid = set(data.get("InvalidParameters") or [])
for name in sys.argv[1:]:
    if name in invalid:
        print("INVALID\t%s" % name)
    elif name in found:
        print("FOUND\t%s\t%s" % (name, found[name].replace("\t", " ").replace("\n", " ")))
    else:
        print("MISSING\t%s" % name)
PY
    )" || {
      echo "[SSM] ERROR failed to parse get-parameters output." >&2
      echo "$GET_PARAMETERS_JSON" >&2
      exit 2
    }

    while IFS=$'\t' read -r status name value; do
      [ -z "$status" ] && continue
      leaf="${name##*/}"
      expected=""
      expected="$(load_expected_value "$leaf")" || exit $?
      case "$status" in
        INVALID|MISSING)
          report_ssm_error "$name" "ParameterNotFound (wrong prefix, name, or region ${AWS_REGION})"
          failed=1
          ;;
        FOUND)
          if [ -z "$value" ] || [ "$value" = "None" ]; then
            report_ssm_error "$name" "parameter exists but value is empty"
            failed=1
          elif [ -n "$expected" ] && [ "$value" != "$expected" ]; then
            report_ssm_error "$name" "actual value does not match expected deployed contract for ${leaf}"
            echo "[SSM] Expected length: ${#expected}; actual length: ${#value}" >&2
            failed=1
          else
            echo "[SSM] present: ${name}"
          fi
          ;;
        *)
          report_ssm_error "$name" "unexpected get-parameters status ${status}"
          failed=1
          ;;
      esac
    done <<< "$chunk_report"
  done
fi

if [ "$failed" -ne 0 ]; then
  echo "[SSM] Validation FAILED" >&2
  exit 1
fi

echo "[SSM] Validation PASSED"
exit 0
