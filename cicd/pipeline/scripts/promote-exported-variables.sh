#!/bin/bash
# Load KEY=value lines into the current CodeBuild shell so env.exported-variables
# can publish them to CodePipeline.
#
# Must be sourced (not executed). `bash run-*.sh` leaves exports in a child
# process; CodePipeline VariableCheck then fails with:
#   Configuration error for rule type: VariableCheck. Variable cannot be empty.
#
# Usage:
#   source promote-exported-variables.sh <env-file> VAR [VAR...]

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "ERROR: source ${BASH_SOURCE[0]}; do not execute it." >&2
  echo "ERROR: CodeBuild exported-variables only see the parent shell." >&2
  exit 1
fi

_promote_fail() {
  echo "ERROR: $*" >&2
  unset -f _promote_fail
  return 1
}

if [ "${CODEBUILD_BUILD_SUCCEEDING:-1}" != "1" ]; then
  echo "Build phase failed; not promoting CodePipeline variables."
  unset -f _promote_fail
  return 0
fi

if [ "$#" -lt 2 ]; then
  _promote_fail "usage: source promote-exported-variables.sh <env-file> VAR [VAR...]"
  return 1
fi

_promote_env_file="$1"
shift

if [ ! -f "$_promote_env_file" ] && [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
  if [ -f "${CODEBUILD_SRC_DIR}/$(basename "$_promote_env_file")" ]; then
    _promote_env_file="${CODEBUILD_SRC_DIR}/$(basename "$_promote_env_file")"
  fi
fi

if [ ! -f "$_promote_env_file" ]; then
  _promote_fail "$_promote_env_file was not written. CodePipeline VariableCheck cannot receive an empty variable."
  return 1
fi

set -a
# shellcheck disable=SC1090
source "$_promote_env_file"
set +a

_promote_var=""
for _promote_var in "$@"; do
  if [ -z "${!_promote_var:-}" ]; then
    echo "ERROR: ${_promote_var} is empty after sourcing ${_promote_env_file}" >&2
    echo "ERROR: CodePipeline VariableCheck fails with 'Variable cannot be empty' when this happens." >&2
    unset -f _promote_fail
    unset _promote_env_file _promote_var
    return 1
  fi
  export "${_promote_var}"
  echo "Exported ${_promote_var}=${!_promote_var}"
done

echo "Promoted CodePipeline variables from ${_promote_env_file}"
unset -f _promote_fail
unset _promote_env_file _promote_var
return 0
