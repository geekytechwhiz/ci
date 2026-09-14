#!/bin/bash
# Classify changed files into deployment layers (service-agnostic).
#
# Globs from env (comma-separated) or change-detection.env:
#   CHANGE_DETECTION_DATA / CHANGE_DETECTION_INFRA / CHANGE_DETECTION_APP / CHANGE_DETECTION_CI
# Fallback when SERVICE_ROOT is set:
#   ${SERVICE_ROOT}/data/**, infrastructure/**, src/** + serverless.yml + config/**, ci/**
#
# Docs paths skip. CI changes → all enabled layers.
#
# Usage:
#   ./detect-changes.sh changed-files.txt
#   git diff --name-only ... | ./detect-changes.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${SERVICE_NAME:-}" ]; then
  # shellcheck source=common.sh
  source "$SCRIPT_DIR/common.sh"
fi

usage() {
  echo "Usage: $0 [changed-files.txt]" >&2
  echo "  Read newline-separated repository file paths from the given file, or from stdin." >&2
  echo "  Writes deployment-manifest.json (or \$DEPLOYMENT_MANIFEST) and prints:" >&2
  echo "    DEPLOY_DATA=true|false" >&2
  echo "    DEPLOY_INFRA=true|false" >&2
  echo "    DEPLOY_APP=true|false" >&2
}

if [ $# -gt 1 ]; then
  echo "ERROR: unexpected arguments: $*" >&2
  usage
  exit 1
fi

if [ $# -eq 0 ] && [ -t 0 ]; then
  usage
  exit 1
fi

CHANGED_FILE=""
if [ $# -eq 1 ]; then
  CHANGED_FILE="$1"
  if [ ! -f "$CHANGED_FILE" ]; then
    echo "ERROR: changed-files list not found: $CHANGED_FILE" >&2
    exit 1
  fi
  if [ ! -r "$CHANGED_FILE" ]; then
    echo "ERROR: changed-files list is not readable: $CHANGED_FILE" >&2
    exit 1
  fi
fi

DEPLOYMENT_MANIFEST="${DEPLOYMENT_MANIFEST:-deployment-manifest.json}"
ENABLE_DATA="${ENABLE_DATA:-true}"
ENABLE_INFRA="${ENABLE_INFRA:-true}"
ENABLE_APP="${ENABLE_APP:-true}"

# Optional change-detection.env next to SERVICE_ROOT / CODEBUILD_SRC_DIR / cwd
load_change_detection_env_file() {
  local candidates=()
  if [ -n "${CHANGE_DETECTION_ENV:-}" ]; then
    candidates+=("$CHANGE_DETECTION_ENV")
  fi
  candidates+=("change-detection.env")
  if [ -n "${SERVICE_ROOT:-${SERVICE_DIR:-}}" ]; then
    candidates+=("${SERVICE_ROOT:-$SERVICE_DIR}/change-detection.env")
    candidates+=("${SERVICE_ROOT:-$SERVICE_DIR}/ci/change-detection.env")
  fi
  if [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
    candidates+=("${CODEBUILD_SRC_DIR}/change-detection.env")
  fi
  local f
  for f in "${candidates[@]}"; do
    if [ -f "$f" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
      echo "Loaded change-detection config: $f"
      return 0
    fi
  done
  return 0
}

load_change_detection_env_file

split_globs() {
  local raw="${1:-}"
  local -a out=()
  local part
  if [ -z "$raw" ]; then
    printf ''
    return 0
  fi
  IFS=',' read -r -a out <<< "$raw"
  for part in "${out[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [ -n "$part" ] && printf '%s\n' "$part"
  done
}

DATA_GLOBS=()
INFRA_GLOBS=()
APP_GLOBS=()
CI_GLOBS=()

while IFS= read -r g; do [ -n "$g" ] && DATA_GLOBS+=("$g"); done < <(split_globs "${CHANGE_DETECTION_DATA:-}")
while IFS= read -r g; do [ -n "$g" ] && INFRA_GLOBS+=("$g"); done < <(split_globs "${CHANGE_DETECTION_INFRA:-}")
while IFS= read -r g; do [ -n "$g" ] && APP_GLOBS+=("$g"); done < <(split_globs "${CHANGE_DETECTION_APP:-}")
while IFS= read -r g; do [ -n "$g" ] && CI_GLOBS+=("$g"); done < <(split_globs "${CHANGE_DETECTION_CI:-}")

# Fallback defaults from SERVICE_ROOT
if [ ${#DATA_GLOBS[@]} -eq 0 ] && [ ${#INFRA_GLOBS[@]} -eq 0 ] && [ ${#APP_GLOBS[@]} -eq 0 ] && [ ${#CI_GLOBS[@]} -eq 0 ]; then
  local_root="${SERVICE_ROOT:-${SERVICE_DIR:-}}"
  if [ -n "$local_root" ]; then
    # Strip leading ./ and trailing /
    local_root="${local_root#./}"
    local_root="${local_root%/}"
    DATA_GLOBS=("${local_root}/data/**" "${local_root}/config/data-*")
    INFRA_GLOBS=("${local_root}/infrastructure/**" "${local_root}/config/infra-*.yml")
    APP_GLOBS=(
      "${local_root}/src/**"
      "${local_root}/serverless.yml"
      "${local_root}/config/**"
    )
    CI_GLOBS=(
      "${local_root}/ci/**"
      "${local_root}/package.json"
      "${local_root}/buildspec.yml"
      "${local_root}/stg-buildspec.yml"
      "${local_root}/prd-buildspec.yml"
    )
    echo "Using SERVICE_ROOT fallback globs under ${local_root}"
  else
    echo "WARN: No CHANGE_DETECTION_* globs and SERVICE_ROOT unset; only docs/ci heuristics apply."
  fi
fi

HAS_DATA=false
HAS_INFRA=false
HAS_APP=false
HAS_CICD=false
ORIGINAL_PATHS=()

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

normalize_path() {
  local p="$1"
  p="${p//$'\r'/}"
  p="${p//\\//}"
  while [ "${p#./}" != "$p" ]; do
    p="${p#./}"
  done
  if [ "${p#/}" != "$p" ]; then
    p="${p#/}"
  fi
  printf '%s' "$p"
}

# Convert simple ** / * globs to a match. Supports ** (any path) and * (one segment).
glob_match() {
  local path="$1"
  local glob="$2"
  glob="${glob#./}"
  PATH_VAL="$path" GLOB_VAL="$glob" node -e '
const path = process.env.PATH_VAL || "";
const glob = process.env.GLOB_VAL || "";
let re = "";
for (let i = 0; i < glob.length; i++) {
  const c = glob[i];
  if (c === "*" && glob[i + 1] === "*") {
    re += ".*";
    i++;
    if (glob[i + 1] === "/") i++;
  } else if (c === "*") {
    re += "[^/]*";
  } else if ("\\.[]{}()+-^$|?".includes(c)) {
    re += "\\" + c;
  } else {
    re += c;
  }
}
process.exit(new RegExp("^" + re + "$").test(path) ? 0 : 1);
'
}

matches_any_glob() {
  local path="$1"
  shift
  local g
  for g in "$@"; do
    if glob_match "$path" "$g"; then
      return 0
    fi
  done
  return 1
}

is_docs_path() {
  local p="$1"
  local base="${p##*/}"
  case "$base" in
    README.md|README.MD|readme.md) return 0 ;;
  esac
  case "$p" in
    docs|docs/*|doc|doc/*) return 0 ;;
    *.md) return 0 ;;
  esac
  return 1
}

classify_path() {
  local p="$1"

  if [ -z "$p" ]; then
    printf '%s' "ignore"
    return 0
  fi

  if is_docs_path "$p"; then
    printf '%s' "docs"
    return 0
  fi

  if [ ${#CI_GLOBS[@]} -gt 0 ] && matches_any_glob "$p" "${CI_GLOBS[@]}"; then
    printf '%s' "cicd"
    return 0
  fi
  if [ ${#DATA_GLOBS[@]} -gt 0 ] && matches_any_glob "$p" "${DATA_GLOBS[@]}"; then
    printf '%s' "data"
    return 0
  fi
  if [ ${#INFRA_GLOBS[@]} -gt 0 ] && matches_any_glob "$p" "${INFRA_GLOBS[@]}"; then
    printf '%s' "infra"
    return 0
  fi
  if [ ${#APP_GLOBS[@]} -gt 0 ] && matches_any_glob "$p" "${APP_GLOBS[@]}"; then
    printf '%s' "app"
    return 0
  fi

  # Heuristic when under SERVICE_ROOT without explicit match
  local root="${SERVICE_ROOT:-${SERVICE_DIR:-}}"
  root="${root#./}"
  root="${root%/}"
  if [ -n "$root" ]; then
    case "$p" in
      "${root}/ci"|"${root}/ci"/*) printf '%s' "cicd"; return 0 ;;
      "${root}/data"|"${root}/data"/*) printf '%s' "data"; return 0 ;;
      "${root}/infrastructure"|"${root}/infrastructure"/*) printf '%s' "infra"; return 0 ;;
      "${root}/src"|"${root}/src"/*|"${root}/serverless.yml"|"${root}/config"|"${root}/config"/*)
        printf '%s' "app"; return 0 ;;
      "${root}"|"${root}"/*)
        printf '%s' "app"; return 0 ;;
    esac
  fi

  printf '%s' "ignore"
}

collect_line() {
  local raw
  raw="$(trim "$1")"
  if [ -z "$raw" ]; then
    return 0
  fi
  case "$raw" in
    \#*) return 0 ;;
  esac
  ORIGINAL_PATHS+=("$raw")
  local normalized category
  normalized="$(normalize_path "$raw")"
  category="$(classify_path "$normalized")"
  case "$category" in
    data) HAS_DATA=true ;;
    infra) HAS_INFRA=true ;;
    app) HAS_APP=true ;;
    cicd) HAS_CICD=true ;;
    docs|ignore) ;;
    *)
      echo "ERROR: unknown classification '$category' for path: $raw" >&2
      exit 1
      ;;
  esac
}

if [ -n "$CHANGED_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    collect_line "$line"
  done < "$CHANGED_FILE"
else
  while IFS= read -r line || [ -n "$line" ]; do
    collect_line "$line"
  done
fi

DEPLOY_DATA=false
DEPLOY_INFRA=false
DEPLOY_APP=false

if [ "$HAS_DATA" = true ]; then
  DEPLOY_DATA=true
  DEPLOY_APP=true
fi
if [ "$HAS_INFRA" = true ]; then
  DEPLOY_INFRA=true
  DEPLOY_APP=true
fi
if [ "$HAS_APP" = true ]; then
  DEPLOY_APP=true
fi
if [ "$HAS_CICD" = true ]; then
  DEPLOY_DATA=true
  DEPLOY_INFRA=true
  DEPLOY_APP=true
fi

# Respect ENABLE_* gates
case "$ENABLE_DATA" in true|TRUE|True|1) ;; *) DEPLOY_DATA=false ;; esac
case "$ENABLE_INFRA" in true|TRUE|True|1) ;; *) DEPLOY_INFRA=false ;; esac
case "$ENABLE_APP" in true|TRUE|True|1) ;; *) DEPLOY_APP=false ;; esac

echo "Changed files:"
if [ ${#ORIGINAL_PATHS[@]} -eq 0 ]; then
  echo "  (none)"
else
  i=0
  while [ "$i" -lt ${#ORIGINAL_PATHS[@]} ]; do
    echo "  ${ORIGINAL_PATHS[$i]}"
    i=$((i + 1))
  done
fi

echo
echo "Deployment decision:"
echo "  Data : $DEPLOY_DATA"
echo "  Infra: $DEPLOY_INFRA"
echo "  App  : $DEPLOY_APP"
echo

manifest_dir="$(dirname "$DEPLOYMENT_MANIFEST")"
mkdir -p "$manifest_dir"

cat > "$DEPLOYMENT_MANIFEST" <<EOF
{
  "deployData": $DEPLOY_DATA,
  "deployInfra": $DEPLOY_INFRA,
  "deployApp": $DEPLOY_APP
}
EOF

echo "Wrote deployment manifest: $DEPLOYMENT_MANIFEST"
echo "DEPLOY_DATA=$DEPLOY_DATA"
echo "DEPLOY_INFRA=$DEPLOY_INFRA"
echo "DEPLOY_APP=$DEPLOY_APP"
