#!/bin/bash
# Load KEY=value lines into the current CodeBuild shell so env.exported-variables
# can publish them to CodePipeline.
#
# Must be sourced (not executed). `bash run-*.sh` leaves exports in a child
# process; CodePipeline VariableCheck then fails with:
#   Configuration error for rule type: VariableCheck. Variable cannot be empty.
#
# Do not `return` or `exit` on the success path. CodeBuild captures exported
# variables after the command wrapper finishes; `return`/`exit` can leave that
# wrapper before the environment is saved, so #{BuildVariables.*} is empty.
#
# Usage:
#   source promote-exported-variables.sh <env-file> VAR [VAR...]

if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  echo "ERROR: source ${BASH_SOURCE[0]:-promote-exported-variables.sh}; do not execute it." >&2
  echo "ERROR: CodeBuild exported-variables only see the parent shell." >&2
  exit 1
fi

_promote_status=0
_promote_fail() {
  echo "ERROR: $*" >&2
  _promote_status=1
}

if [ "${CODEBUILD_BUILD_SUCCEEDING:-1}" != "1" ]; then
  echo "Build phase failed; not promoting CodePipeline variables."
elif [ "$#" -lt 2 ]; then
  _promote_fail "usage: source promote-exported-variables.sh <env-file> VAR [VAR...]"
else
  _promote_env_file="$1"
  shift

  if [ ! -f "$_promote_env_file" ] && [ -n "${CODEBUILD_SRC_DIR:-}" ]; then
    if [ -f "${CODEBUILD_SRC_DIR}/$(basename "$_promote_env_file")" ]; then
      _promote_env_file="${CODEBUILD_SRC_DIR}/$(basename "$_promote_env_file")"
    fi
  fi

  if [ ! -f "$_promote_env_file" ]; then
    _promote_fail "$_promote_env_file was not written. CodePipeline VariableCheck cannot receive an empty variable."
  else
    set -a
    # shellcheck disable=SC1090
    source "$_promote_env_file"
    set +a

    _promote_var=""
    for _promote_var in "$@"; do
      if [ -z "${!_promote_var:-}" ]; then
        echo "ERROR: ${_promote_var} is empty after sourcing ${_promote_env_file}" >&2
        echo "ERROR: CodePipeline VariableCheck fails with 'Variable cannot be empty' when this happens." >&2
        _promote_status=1
        break
      fi
      export "${_promote_var}"
      echo "Exported ${_promote_var}=${!_promote_var}"
    done

    if [ "$_promote_status" -eq 0 ]; then
      echo "Promoted CodePipeline variables from ${_promote_env_file}"
    fi
  fi
fi

unset -f _promote_fail
unset _promote_env_file _promote_var
if [ "$_promote_status" -ne 0 ]; then
  unset _promote_status
  false
fi
unset _promote_status
