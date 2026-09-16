# Workflow Service — Data Stack (POC)

```text
{stage}-workflow-service-data
        ↓
DynamoDB  workflow-service-{stage}
        ↓
SSM  /{stage}/workflow-service/TABLE_NAME
     /{stage}/workflow-service/TABLE_ARN
     /{stage}/workflow-service/STREAM_ARN
        ↓
{stage}-workflow-service-infra  (SQS + infra SSM — not this directory)
{stage}-workflow-service        (application — not this directory)
```

This directory is the **data CloudFormation stack**. It owns the POC DynamoDB table and the data SSM contract. It does not contain Lambda, API Gateway, SQS, or EventBridge.

Normal CI/CD deploys this stack from CodePipeline stage **Deploy-Data** via `ci/preflight-data.sh` then `ci/deploy-data.sh` (create or update of the commit-scoped artifact). Preflight is the primary classifier and `deploy-data.sh` consumes `deployment-data-preflight.env`. When the Data stack is missing and the retained table still exists with verified ownership and compatible configuration, preflight returns `RECOVERY_REQUIRED`. Deploy-Data then prepares an IMPORT-only change set for `WorkflowTable`. After manual approval, Recover-Data imports the existing table and performs a normal CloudFormation UPDATE from the immutable commit-scoped Data artifact, which recreates the non-retained SSM contract.

Pipeline validation always uses:

```text
s3://$ARTIFACT_BUCKET/workflow-service/$CURRENT_COMMIT/data/packaged.yaml
```

A local `data/packaged.yaml` is used only for manual/emergency/test runs when `CURRENT_COMMIT` is unset.

## What this stack owns

| Resource | Physical name | SSM |
|----------|---------------|-----|
| DynamoDB table | `workflow-service-{stage}` | `TABLE_NAME`, `TABLE_ARN`, `STREAM_ARN` |
| SSM parameters | `/{stage}/workflow-service/TABLE_*`, `STREAM_ARN` | (this table) |

The table uses `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. Deleting the Data Stack does **not** delete the table. The next deploy must **not** create a new table; preflight returns `RECOVERY_REQUIRED` and the controlled IMPORT → UPDATE recovery workflow re-adopts the retained table.

This stack does **not** create Lambda, API Gateway, SQS, EventBridge, application IAM, or event source mappings.

## Layout

```text
data/
├── serverless.data.yml    # stack {stage}-workflow-service-data
├── resources/
│   └── data.yml           # DynamoDB + data SSM
└── README.md
```

CI/CD deployment artifacts are published to the centralized environment bucket (`ARTIFACT_BUCKET`, e.g. `dev-mibc-artifacts`) under `workflow-service/<commit-sha>/`. Serverless `provider.deploymentBucket` in this stack file is packaging-internal only.

## Cross-stack contract

Do **not** `Fn::ImportValue` these resources. Other stacks read SSM at deploy time:

```yaml
WORKFLOW_TABLE: '{{resolve:ssm:/${self:provider.stage}/workflow-service/TABLE_NAME}}'
```

## Package locally

```bash
cd data
npx serverless print --config serverless.data.yml --stage dev
npx serverless package --config serverless.data.yml --stage dev --package .serverless
```

The packaged template is copied to `data/packaged.yaml` by `ci/build.sh`.
