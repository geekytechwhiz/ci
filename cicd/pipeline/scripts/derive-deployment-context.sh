#!/usr/bin/env bash
# Derive deployment context values shared by the generic CI/CD stack.
# Service-agnostic: platform/stage/region/project codes come from environment config.
set -euo pipefail

# Map AWS region to a short code used in physical resource name prefixes.
region_to_short_code() {
  local region="${1:-}"
  case "$region" in
    us-east-1) printf 'use1' ;;
    us-east-2) printf 'use2' ;;
    us-west-1) printf 'usw1' ;;
    us-west-2) printf 'usw2' ;;
    ap-south-1) printf 'aps1' ;;
    ap-northeast-1) printf 'apne1' ;;
    ap-southeast-1) printf 'apse1' ;;
    ap-southeast-2) printf 'apse2' ;;
    eu-west-1) printf 'euw1' ;;
    eu-central-1) printf 'euc1' ;;
    *)
      echo "ERROR: Unknown AWS region for short-code mapping: ${region}" >&2
      return 1
      ;;
  esac
}

# RESOURCE_NAME_PREFIX = {platformCode}{stage}-{regionShortCode}-{projectCode}
# Example: nv + dev + -use1-mvx => nvdev-use1-mvx
derive_resource_name_prefix() {
  local platform_code="${1:?platform_code required}"
  local stage="${2:?stage required}"
  local region="${3:?region required}"
  local project_code="${4:?project_code required}"
  local region_short

  region_short="$(region_to_short_code "$region")"
  printf '%s%s-%s-%s' "$platform_code" "$stage" "$region_short" "$project_code"
}

# Service SSM contract prefix: /{resourceNamePrefix}/{serviceName}
derive_ssm_prefix() {
  local resource_name_prefix="${1:?resource_name_prefix required}"
  local service_name="${2:?service_name required}"
  printf '/%s/%s' "$resource_name_prefix" "$service_name"
}
