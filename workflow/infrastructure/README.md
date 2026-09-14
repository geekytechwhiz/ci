# Workflow Service — Infrastructure Stack (POC)

```text
{stage}-workflow-service-infra
        ↓
SQS  {stage}-workflow-service-events
        ↓
SSM  /{stage}/workflow-service/SQS_QUEUE_URL
     /{stage}/workflow-service/SQS_QUEUE_ARN
        ↓
{stage}-workflow-service  (application — not this directory)
```

This directory is the **infrastructure CloudFormation stack**. It does not contain Lambda or API Gateway.

This is a **minimal POC**. It proves one CodePipeline can deploy a separate infrastructure stack that publishes resource identifiers to SSM for a separate application stack to consume. DynamoDB lives in the **Data Stack** (`../data/`), not here. It does **not** migrate production EventBridge, DynamoDB, or existing ingest queues.

Normal CI/CD deploys this stack from CodePipeline stage **Deploy-Infra** using
`ci/deploy-infra.sh` is used by CodePipeline **Deploy-Infra** (and remains available for manual/emergency deploys). The template is the commit-scoped artifact `workflow-service/<commit-sha>/infra/packaged.yaml`.
`ci/deploy-infra.sh` is retained for manual/emergency updates only. This script
does not deploy the application stack.

## What this stack owns

| Resource | Physical name | SSM |
|----------|---------------|-----|
| SQS queue | `{stage}-workflow-service-events` | `SQS_QUEUE_URL`, `SQS_QUEUE_ARN` |
| SSM parameters | `/{stage}/workflow-service/SQS_QUEUE_*` | (this table) |

This stack does **not** create Lambda, API Gateway, EventBridge, DynamoDB, SNS, application IAM roles, or event source mappings. DynamoDB is owned by `{stage}-workflow-service-data`.

The queue name `{stage}-workflow-service-events` is distinct from the existing production ingest queue `{stage}-workflow-service-events-ingest`. This POC does not import, rename, or delete production resources.

## Layout

```text
infrastructure/
├── serverless.infra.yml    # stack {stage}-workflow-service-infra
├── resources/
│   └── infra.yml           # SQS queue + SSM parameters
└── README.md
```

Stage values live next to application config:

```text
config/infra-dev.yml
config/infra-stg.yml
config/infra-prd.yml
```

CI/CD deployment artifacts are published to the centralized environment bucket (`ARTIFACT_BUCKET`, e.g. `dev-mibc-artifacts`) under `workflow-service/<commit-sha>/`. Serverless `provider.deploymentBucket` in this stack file is packaging-internal only.

## Cross-stack contract

The application stack must **not** `Fn::ImportValue` these resources. It reads SSM at deploy time:

```yaml
arn: '{{resolve:ssm:/${self:provider.stage}/workflow-service/SQS_QUEUE_ARN}}'
```

The SQS → ingest Lambda event source mapping stays in the **application** stack.

The application stack (not this directory) is a lightweight POC: one API Lambda for all HTTP routes, one SQS consumer Lambda, and one DynamoDB Stream relay Lambda. Existing API paths, methods, authorizers, and CORS are unchanged; they all target the single `api` Lambda.

## Package locally

```bash
cd apps/workflow-service/infrastructure
npx serverless print --config serverless.infra.yml --stage dev
npx serverless package --config serverless.infra.yml --stage dev --package .serverless
```

The packaged template is copied to `infrastructure/packaged.yaml` by `ci/build.sh`.
