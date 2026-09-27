#!/usr/bin/env bash
# One-time operator recovery: import an existing custom EventBus into the
# infrastructure stack. This is NOT part of normal CI/CD (Deploy-Infra denies
# CloudFormation IMPORT).
#
# Usage:
#   AWS_PROFILE=... STAGE=dev ./recover-event-bus.sh
#
# Required env:
#   STAGE                 (dev|stg|prd)
# Optional env:
#   AWS_REGION            (from deployment context; default us-east-1 for local runs)
#   EVENT_BUS_NAME        (optional; default from workflow/config/naming.yml eventBusName)
#   SERVICE_NAME          (default workflow-service)
#   INFRA_STACK_NAME      (default ${STAGE}-${SERVICE_NAME}-infra)
#   EVENT_BUS_NAME        (default workflow-service-bus-${STAGE})
#   EVENT_BUS_LOGICAL_ID  (default WorkflowEventsBus)
#   CFN_DEPLOY_ROLE_ARN   (default ${STAGE}-${SERVICE_NAME}-cfn-deploy-role)
#
# Safety:
#   Never deletes, recreates, or renames the EventBus.
#   Aborts if the stack already tracks the logical ID.
#   Aborts if another live stack already tracks the physical bus.

set -euo pipefail

STAGE="${STAGE:?STAGE must be set (dev, stg, or prd)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SERVICE_NAME="${SERVICE_NAME:-workflow-service}"
INFRA_STACK_NAME="${INFRA_STACK_NAME:-${STAGE}-${SERVICE_NAME}-infra}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAMING_FILE="${NAMING_FILE:-${SCRIPT_DIR}/../config/naming.yml}"
if [ -z "${EVENT_BUS_NAME:-}" ] && [ -f "$NAMING_FILE" ]; then
  EVENT_BUS_NAME="$(grep -E '^[[:space:]]*eventBusName:[[:space:]]*' "$NAMING_FILE" | head -1 | sed -E 's/^[[:space:]]*eventBusName:[[:space:]]*//; s/^["'\''']|["'\''']$//g')"
fi
EVENT_BUS_NAME="${EVENT_BUS_NAME:-workflow-service-bus-${STAGE}}"
EVENT_BUS_LOGICAL_ID="${EVENT_BUS_LOGICAL_ID:-WorkflowEventsBus}"
CFN_DEPLOY_ROLE_ARN="${CFN_DEPLOY_ROLE_ARN:-arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/${STAGE}-${SERVICE_NAME}-cfn-deploy-role}"
WORKDIR="${WORKDIR:-$(mktemp -d /tmp/eventbus-import-XXXXXX)}"
CHANGE_SET_NAME="${CHANGE_SET_NAME:-import-${EVENT_BUS_LOGICAL_ID}-$(date +%s)}"
IMPORT_TEMPLATE="${WORKDIR}/import-template.json"
RESOURCES_TO_IMPORT="${WORKDIR}/resources-to-import.json"

log() { printf '[EVENTBUS-IMPORT] %s\n' "$*"; }
fail_stop() { log "ERROR: $*"; log "The EventBus was not deleted, recreated, renamed, or imported."; exit 1; }

log "stage=${STAGE} stack=${INFRA_STACK_NAME} bus=${EVENT_BUS_NAME} logicalId=${EVENT_BUS_LOGICAL_ID}"
log "workdir=${WORKDIR}"

account="$(aws sts get-caller-identity --query Account --output text)"
bus_arn="arn:aws:events:${AWS_REGION}:${account}:event-bus/${EVENT_BUS_NAME}"

if ! aws events describe-event-bus --region "${AWS_REGION}" --name "${EVENT_BUS_NAME}" >/dev/null 2>&1; then
  fail_stop "EventBus ${EVENT_BUS_NAME} does not exist. Import requires the existing physical bus."
fi

stack_status="$(aws cloudformation describe-stacks --region "${AWS_REGION}" --stack-name "${INFRA_STACK_NAME}" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
case "${stack_status}" in
  CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE) ;;
  *) fail_stop "Stack ${INFRA_STACK_NAME} is not import-ready (status=${stack_status:-missing})." ;;
esac

if aws cloudformation describe-stack-resource \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --logical-resource-id "${EVENT_BUS_LOGICAL_ID}" >/dev/null 2>&1; then
  physical="$(aws cloudformation describe-stack-resource \
    --region "${AWS_REGION}" \
    --stack-name "${INFRA_STACK_NAME}" \
    --logical-resource-id "${EVENT_BUS_LOGICAL_ID}" \
    --query 'StackResourceDetail.PhysicalResourceId' --output text)"
  log "Stack already owns ${EVENT_BUS_LOGICAL_ID} (PhysicalResourceId=${physical}). Nothing to import."
  exit 0
fi

live_template_json="$(aws cloudformation get-template --region "${AWS_REGION}" --stack-name "${INFRA_STACK_NAME}" --query TemplateBody --output json)"

python3 - "${live_template_json}" "${IMPORT_TEMPLATE}" "${RESOURCES_TO_IMPORT}" "${EVENT_BUS_LOGICAL_ID}" "${EVENT_BUS_NAME}" "${STAGE}" "${SERVICE_NAME}" <<'PY'
import json, sys
template = json.loads(sys.argv[1])
if isinstance(template, str):
    template = json.loads(template)
dest_template, dest_import, logical_id, bus_name, stage, service = sys.argv[2:8]
resources = dict(template.get("Resources") or {})
if logical_id in resources:
    raise SystemExit(f"Live template already contains {logical_id}; refusing to import.")
for key, resource in resources.items():
    if resource.get("Type") == "AWS::Events::EventBus":
        raise SystemExit(f"Live template already contains EventBus {key}; refusing to import.")
resources[logical_id] = {
    "Type": "AWS::Events::EventBus",
    "DeletionPolicy": "Retain",
    "UpdateReplacePolicy": "Retain",
    "Properties": {
        "Name": bus_name,
        "Tags": [
            {"Key": "Service", "Value": service},
            {"Key": "Stage", "Value": stage},
            {"Key": "ManagedBy", "Value": "serverless"},
        ],
    },
}
out = {
    "AWSTemplateFormatVersion": template.get("AWSTemplateFormatVersion", "2010-09-09"),
    "Description": "IMPORT-ONLY: adopt existing EventBus into the current infrastructure stack. No other resources are created or deleted.",
    "Resources": resources,
}
with open(dest_template, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
    fh.write("\n")
with open(dest_import, "w", encoding="utf-8") as fh:
    json.dump([{
        "ResourceType": "AWS::Events::EventBus",
        "LogicalResourceId": logical_id,
        "ResourceIdentifier": {"Name": bus_name},
    }], fh, indent=2)
    fh.write("\n")
PY

identifier_prop="$(aws cloudformation get-template-summary \
  --region "${AWS_REGION}" \
  --template-body "file://${IMPORT_TEMPLATE}" \
  --query "ResourceIdentifierSummaries[?ResourceType=='AWS::Events::EventBus'].ResourceIdentifiers[0]" \
  --output text)"
if [ "${identifier_prop}" != "Name" ]; then
  fail_stop "Unexpected EventBus import identifier '${identifier_prop}'. Expected Name."
fi

log "Creating IMPORT change set ${CHANGE_SET_NAME} (does not modify the EventBus until execute-change-set)"
aws cloudformation create-change-set \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --change-set-name "${CHANGE_SET_NAME}" \
  --change-set-type IMPORT \
  --template-body "file://${IMPORT_TEMPLATE}" \
  --resources-to-import "file://${RESOURCES_TO_IMPORT}" \
  --role-arn "${CFN_DEPLOY_ROLE_ARN}" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --description "One-time import of existing EventBus ${EVENT_BUS_NAME} as ${EVENT_BUS_LOGICAL_ID}. Does not delete or recreate the bus."

aws cloudformation wait change-set-create-complete \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --change-set-name "${CHANGE_SET_NAME}" \
  || true

cs_json="$(aws cloudformation describe-change-set \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --change-set-name "${CHANGE_SET_NAME}" \
  --output json)"
python3 - "${cs_json}" "${EVENT_BUS_LOGICAL_ID}" <<'PY'
import json, sys
cs = json.loads(sys.argv[1])
logical_id = sys.argv[2]
status = cs.get("Status")
reason = cs.get("StatusReason") or ""
if status != "CREATE_COMPLETE":
    raise SystemExit(f"Change set status {status}: {reason}")
changes = cs.get("Changes") or []
if len(changes) != 1:
    raise SystemExit(f"Expected exactly 1 change (Import EventBus), got {len(changes)}: {json.dumps(changes)}")
rc = changes[0].get("ResourceChange") or {}
if rc.get("Action") != "Import":
    raise SystemExit(f"Expected Action=Import, got {rc.get('Action')}")
if rc.get("LogicalResourceId") != logical_id:
    raise SystemExit(f"Expected LogicalResourceId={logical_id}, got {rc.get('LogicalResourceId')}")
if rc.get("ResourceType") != "AWS::Events::EventBus":
    raise SystemExit(f"Expected AWS::Events::EventBus, got {rc.get('ResourceType')}")
print("[EVENTBUS-IMPORT] Change set verified: Action=Import LogicalResourceId=%s" % logical_id)
PY

log "Executing IMPORT. EventBus ARN ${bus_arn} will be preserved."
aws cloudformation execute-change-set \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --change-set-name "${CHANGE_SET_NAME}"

aws cloudformation wait stack-import-complete \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}"

owned="$(aws cloudformation describe-stack-resource \
  --region "${AWS_REGION}" \
  --stack-name "${INFRA_STACK_NAME}" \
  --logical-resource-id "${EVENT_BUS_LOGICAL_ID}" \
  --query 'StackResourceDetail.{Status:ResourceStatus,Physical:PhysicalResourceId}' \
  --output json)"
log "Import complete: ${owned}"
log "Next: normal Deploy-Infra UPDATE creates rules, queue policy, and EVENT_BUS_* SSM parameters."
log "Do not delete or rename ${EVENT_BUS_NAME}."
