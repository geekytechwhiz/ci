#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CICD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE=""
STAGE=""

# Parse positional or flag args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service|-s)
      SERVICE="$2"
      shift 2
      ;;
    --stage|-e)
      STAGE="$2"
      shift 2
      ;;
    *)
      if [ -z "$SERVICE" ]; then
        SERVICE="$1"
      elif [ -z "$STAGE" ]; then
        STAGE="$1"
      fi
      shift
      ;;
  esac
done

SERVICE="${SERVICE:-workflow-service}"
STAGE="${STAGE:-dev}"

echo "========================================"
echo "VALIDATING SERVICE & ENVIRONMENT CONFIG"
echo "========================================"
echo "Service: $SERVICE"
echo "Stage:   $STAGE"

ENV_CONFIG="$CICD_ROOT/config/environments/${STAGE}.yaml"
SVC_CONFIG="$CICD_ROOT/config/services/${SERVICE}/${STAGE}.yaml"
SCHEMA_PATH="$CICD_ROOT/pipeline/config/schema.json"

if [ ! -f "$ENV_CONFIG" ]; then
  echo "ERROR: Environment configuration file not found: $ENV_CONFIG" >&2
  exit 1
fi

if [ ! -f "$SVC_CONFIG" ]; then
  echo "ERROR: Service configuration file not found: $SVC_CONFIG" >&2
  exit 1
fi

# Validation logic via Node.js
node <<NODE
const fs = require('fs');

function parseYamlSimple(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  let currentSection = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (!line.startsWith(' ') && line.includes(':')) {
      const parts = trimmed.split(':');
      currentSection = parts[0].trim();
      const val = parts.slice(1).join(':').trim();
      result[currentSection] = val ? val : {};
    } else if (currentSection && line.startsWith('  ') && line.includes(':')) {
      const parts = trimmed.split(':');
      const key = parts[0].trim();
      const val = parts.slice(1).join(':').trim();
      if (typeof result[currentSection] !== 'object') {
        result[currentSection] = {};
      }
      result[currentSection][key] = val;
    }
  }
  return { content, raw: result };
}

console.log("Validating environment config: ${ENV_CONFIG}");
const envParsed = parseYamlSimple("${ENV_CONFIG}");
if (!envParsed.content.includes("environment:")) throw new Error("Missing environment block in ${ENV_CONFIG}");
if (!envParsed.content.includes("github:")) throw new Error("Missing github block in ${ENV_CONFIG}");
if (!envParsed.content.includes("artifacts:")) throw new Error("Missing artifacts block in ${ENV_CONFIG}");
console.log("Environment config structure: VALID");

console.log("Validating service config: ${SVC_CONFIG}");
const svcParsed = parseYamlSimple("${SVC_CONFIG}");
if (!svcParsed.content.includes("service:")) throw new Error("Missing service block in ${SVC_CONFIG}");
if (!svcParsed.content.includes("source:")) throw new Error("Missing source block in ${SVC_CONFIG}");
if (!svcParsed.content.includes("deployment:")) throw new Error("Missing deployment block in ${SVC_CONFIG}");
if (!svcParsed.content.includes("changeDetection:")) throw new Error("Missing changeDetection block in ${SVC_CONFIG}");
console.log("Service config structure: VALID");

NODE

echo "======================================="
echo "Configuration validation PASSED"
echo "======================================="
