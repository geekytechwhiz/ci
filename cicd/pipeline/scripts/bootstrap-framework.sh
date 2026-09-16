#!/bin/bash
# Resolve CICD_FRAMEWORK_DIR: prefer a local FrameworkPath in the source tree,
# otherwise download the framework bundle from S3.
#
# Sets and exports:
#   CICD_FRAMEWORK_DIR  — pipeline root (contains scripts/ and buildspecs/)
#   CICD_SCRIPTS_DIR    — ${CICD_FRAMEWORK_DIR}/scripts
#
# Env (optional):
#   FRAMEWORK_PATH / FrameworkPath — local path to cicd/pipeline (or its scripts/)
#   FRAMEWORK_BUNDLE_S3_URI / ARTIFACT_BUCKET — optional fallback download when
#     cicd/pipeline is not in the source tree. Not produced by deploy-pipeline.sh.
#   FRAMEWORK_BUNDLE_KEY           — default: cicd-framework/pipeline/latest/cicd-pipeline.tgz
#   CODEBUILD_SRC_DIR              — CodeBuild source root

set -euo pipefail

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

is_framework_root() {
  local dir="$1"
  [ -d "$dir/scripts" ] && [ -f "$dir/scripts/common.sh" ]
}

resolve_from_candidate() {
  local candidate="$1"
  candidate="$(trim "$candidate")"
  [ -z "$candidate" ] && return 1

  if [ ! -e "$candidate" ]; then
    return 1
  fi

  # Absolute-ize
  if [ -d "$candidate" ]; then
    candidate="$(cd "$candidate" && pwd)"
  elif [ -f "$candidate" ]; then
    candidate="$(cd "$(dirname "$candidate")" && pwd)"
  else
    return 1
  fi

  if is_framework_root "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi
  # Candidate may be …/scripts
  if [ -f "$candidate/common.sh" ] && is_framework_root "$(dirname "$candidate")"; then
    printf '%s' "$(cd "$(dirname "$candidate")" && pwd)"
    return 0
  fi
  # Candidate may be …/cicd with pipeline/ underneath
  if is_framework_root "$candidate/pipeline"; then
    printf '%s' "$(cd "$candidate/pipeline" && pwd)"
    return 0
  fi
  return 1
}

download_framework_bundle() {
  local uri="${FRAMEWORK_BUNDLE_S3_URI:-}"
  local dest_parent work extract_root
  local key="${FRAMEWORK_BUNDLE_KEY:-cicd-framework/pipeline/latest/cicd-pipeline.tgz}"

  if [ -z "$uri" ]; then
    if [ -z "${ARTIFACT_BUCKET:-}" ]; then
      echo "ERROR: No local framework found and FRAMEWORK_BUNDLE_S3_URI / ARTIFACT_BUCKET unset." >&2
      return 1
    fi
    uri="s3://${ARTIFACT_BUCKET}/${key}"
  fi

  dest_parent="${TMPDIR:-/tmp}/cicd-framework.$$"
  mkdir -p "$dest_parent"
  echo "Downloading CI/CD framework bundle from ${uri}"
  if ! aws s3 cp "$uri" "$dest_parent/cicd-pipeline.tgz"; then
    echo "ERROR: Failed to download framework bundle ${uri}" >&2
    return 1
  fi

  extract_root="$dest_parent/extract"
  mkdir -p "$extract_root"
  tar -xzf "$dest_parent/cicd-pipeline.tgz" -C "$extract_root"

  # Bundle may contain pipeline/ at top level, or scripts/ directly, or cicd/pipeline/
  work="$(find "$extract_root" -type f -name 'common.sh' -path '*/scripts/common.sh' 2>/dev/null | head -n 1 || true)"
  if [ -z "$work" ]; then
    echo "ERROR: Downloaded framework bundle does not contain scripts/common.sh" >&2
    return 1
  fi
  printf '%s' "$(cd "$(dirname "$work")/.." && pwd)"
}

main() {
  local resolved=""
  local candidate

  # 1) Explicit path
  for candidate in "${FRAMEWORK_PATH:-}" "${FrameworkPath:-}"; do
    if resolved="$(resolve_from_candidate "$candidate")"; then
      break
    fi
    resolved=""
  done

  # 2) Relative to this script (when the framework is already checked in)
  if [ -z "$resolved" ]; then
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if is_framework_root "$here"; then
      resolved="$here"
    fi
  fi

  # 3) Common repo layouts under CODEBUILD_SRC_DIR
  if [ -z "$resolved" ] && [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
    for candidate in \
      "${CODEBUILD_SRC_DIR}/cicd/pipeline" \
      "${CODEBUILD_SRC_DIR}/pipeline"
    do
      if resolved="$(resolve_from_candidate "$candidate")"; then
        break
      fi
      resolved=""
    done
  fi

  # 4) S3 download
  if [ -z "$resolved" ]; then
    resolved="$(download_framework_bundle)" || exit 1
  fi

  if ! is_framework_root "$resolved"; then
    echo "ERROR: Resolved framework path is invalid: $resolved" >&2
    exit 1
  fi

  export CICD_FRAMEWORK_DIR="$resolved"
  export CICD_SCRIPTS_DIR="${CICD_FRAMEWORK_DIR}/scripts"
  chmod +x "${CICD_SCRIPTS_DIR}"/*.sh 2>/dev/null || true

  echo "CICD_FRAMEWORK_DIR=${CICD_FRAMEWORK_DIR}"
  echo "CICD_SCRIPTS_DIR=${CICD_SCRIPTS_DIR}"
}

main "$@"
