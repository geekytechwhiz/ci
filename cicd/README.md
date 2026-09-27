# Generic CI/CD framework

The Common CI/CD CloudFormation template is the source of truth. After the stack exists, CodePipeline is executable. `deploy-pipeline.sh` is an optional wrapper around that same template.

```text
                  ┌───────────────────────────┐
                  │ Common CloudFormation     │
                  │ Stack                     │
                  │                           │
                  │ CodePipeline              │
                  │ CodeBuild projects        │
                  │ Artifact store (existing) │
                  │ IAM / deploy roles        │
                  │ Deployment context        │
                  └─────────────┬─────────────┘
                                │
                         CodePipeline
                                │
              Build → Deploy-Data → Deploy-Infra → Validate-SSM → Deploy-App → Smoke-Test → Record-Deployment
```

Data Preflight runs inside Deploy-Data. Approve-Data-Recovery and Recover-Data run only when `RECOVERY_REQUIRED=true`.

## Mode A — Initial POC (required)

DevOps creates or updates the Common stack **directly** in CloudFormation. Do not run `deploy-pipeline.sh` first.

1. Confirm the [external prerequisites](#external-prerequisites).
2. Upload or select `cicd/cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml`.
   - Template size is above the 51,200-byte inline body limit. Use an S3 template URL, `aws cloudformation deploy --s3-bucket`, or the console **Upload a template file** path (CloudFormation stores the file in S3).
3. Enter the [Common stack parameters](#common-stack-parameters).
4. Create or **update** the stack `{Stage}-{ServiceName}-cicd` (example `dev-workflow-service-cicd`). Prefer UPDATE of the existing POC stack. Do not delete the pipeline, CodeBuild projects, artifact buckets, DynamoDB tables, or queues to “clean up” architecture.
5. Wait for `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
6. Open CodePipeline (`{Stage}-{ServiceName}-pipeline`).
7. Start the pipeline manually (Release change). Stages themselves stay automated.
8. Monitor Source → Build → Deploy-Data → Deploy-Infra → Validate-SSM → Deploy-App → Smoke-Test → Record-Deployment.

Do **not** manually run `build.sh`, Data Preflight, Deploy-Data, Deploy-Infra, Validate-SSM, Deploy-App, Smoke-Test, or Record-Deployment. Those are CodePipeline/CodeBuild responsibilities.

Example CLI (same stack definition as the console):

```bash
aws s3 cp cicd/cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml \
  s3://EXISTING_PIPELINE_ARTIFACT_BUCKET/cicd/cloudformation/generic-codepipeline.yml

aws cloudformation deploy \
  --template-file cicd/cloudformation/pipeline/generic-codepipeline-validation-fixed-v3.yml \
  --s3-bucket EXISTING_PIPELINE_ARTIFACT_BUCKET \
  --s3-prefix cicd/cloudformation/dev-workflow-service-cicd \
  --stack-name dev-workflow-service-cicd \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides \
    ServiceName=workflow-service \
    Stage=dev \
    GitHubConnectionArn=arn:aws:codeconnections:us-east-1:ACCOUNT:connection/ID \
    GitHubFullRepositoryId=org/repo \
    GitHubBranch=dev \
    ArtifactBucketName=EXISTING_PIPELINE_ARTIFACT_BUCKET \
    ArtifactBucket=EXISTING_DEPLOYMENT_ARTIFACT_BUCKET \
    ResourceNamePrefix=nvdev-use1-mvx \
    CiPath=workflow/ci \
    EnableSsmValidation=false
```

A parameter file example is `cicd/cloudformation/pipeline/manual-stack-parameters.example.json`.

## Mode B — Future automation (optional)

```text
deploy-pipeline.sh → CloudFormation → Common Pipeline Stack → CodePipeline
```

```bash
make -C cicd deploy SERVICE=workflow-service STAGE=dev
# or
./cicd/scripts/deploy-pipeline.sh --service workflow-service --stage dev
```

The script reads `cicd/config/environments/{stage}.yaml` and `cicd/config/services/{service}/{stage}.yaml`, then calls `aws cloudformation deploy` against the **same** template. It does not create IAM roles, CodeBuild projects, buckets, or pipelines itself.

## External prerequisites

These must already exist. They are not created by the Common stack or by `deploy-pipeline.sh`:

| Prerequisite | Why |
|--------------|-----|
| AWS CodeConnections connection in `AVAILABLE` status | Source action. Console OAuth is required; a connection created only via API stays `PENDING`. |
| CodePipeline artifact store bucket (`ArtifactBucketName`) | Pipeline Source/Build zip store. Reuse the existing POC bucket. |
| Deployment artifact bucket (`ArtifactBucket`) | Commit-scoped `s3://bucket/{ServiceName}/{commit}/...` packages. Reuse the existing POC bucket. |
| Source repository contains `cicd/pipeline` | CodeBuild `FRAMEWORK_PATH=cicd/pipeline`. `make package` / S3 framework bundle is only a fallback when that tree is absent. |

Not required before stack create:

- Pre-created CodeBuild projects
- Pre-created pipeline IAM roles
- Pre-created CloudFormation deploy/recovery roles
- Pre-created SSM parameters (`LAST_DEPLOYED_COMMIT` and service contract params are written by pipeline stages)
- Running `deploy-pipeline.sh`
- Files under `/tmp` or locally generated IAM/policies

## Common stack parameters vs service deployment

### Required for a manual create

| Parameter | Example | Notes |
|-----------|---------|--------|
| `ServiceName` | `workflow-service` | Pipeline identity (CodePipeline, CodeBuild, artifact prefix `{ServiceName}/{commit}`). May differ from the Serverless application service name. |
| `Stage` | `dev` | `dev` / `stg` / `prd` |
| `GitHubConnectionArn` | CodeConnections ARN | Existing AVAILABLE connection |
| `GitHubFullRepositoryId` | `org/repo` | |
| `GitHubBranch` | `dev` | |
| `ArtifactBucketName` | existing pipeline bucket | External |
| `ArtifactBucket` | existing deployment bucket | External |

### Recommended for POC naming

| Parameter | Example | Notes |
|-----------|---------|--------|
| `ResourceNamePrefix` | `nvdev-use1-mvx` | Propagated to CodeBuild as `RESOURCE_NAME_PREFIX`. Empty derives `{PlatformCode}{Stage}-{RegionShortCode}-{ProjectCode}`. |
| `CiPath` | `workflow/ci` | Service packaging hooks |
| `SsmPrefix` | `/nvdev-use1-mvx/workflow-service` | Authoritative application SSM contract. Required when `EnableSsmValidation` is true. Empty is not rewritten as `/{Stage}/{ServiceName}` or `/{ResourceNamePrefix}/{ServiceName}`. |
| `EnableSsmValidation` | `false` | Default false. Validate-SSM skips unless you opt in. When true, also set `SsmPrefix` and `RequiredSsmParameters`. |
| `RequiredSsmParameters` | `TABLE_NAME,TABLE_ARN,STREAM_ARN,SQS_QUEUE_URL,SQS_QUEUE_ARN,EVENT_BUS_NAME,EVENT_BUS_ARN` | Leaf names only. Do not include the prefix. Required only when `EnableSsmValidation` is true. |

### Optional / derived

`PipelineName` empty → `{Stage}-{ServiceName}-pipeline`. `PlatformCode` default `nv`. `ProjectCode` default `mvx`. `RegionShortCode` empty → mapping for `AWS::Region`. Feature toggles default `true`. `EnableSsmValidation` defaults `false`. Existing stacks keep previous values, so an earlier `true` must be set to `false` on the next update.

The Common stack must **not** be given individual workflow-service resource names (`…-db`, `…-events`, `…-bus`). The service build produces those from `RESOURCE_NAME_PREFIX` plus service suffixes.

## Pipeline identity vs application identity

```text
Pipeline identity (SERVICE_NAME / ServiceName)
  CodePipeline, CodeBuild projects, IAM role names
  Artifact root: s3://$ARTIFACT_BUCKET/$SERVICE_NAME/$COMMIT/
  Pipeline SSM: /$STAGE/$SERVICE_NAME/cicd/*

Application identity (serverless.yml service: workflow-service)
  Physical resource names: $RESOURCE_NAME_PREFIX-workflow-service-*
  Runtime SSM: $SSM_PREFIX  (example /nvdev-use1-mvx/workflow-service)
  Lambda environment SERVICE_NAME=workflow-service
```

A pipeline named `cloud-formation-testing` can deploy the `workflow-service` application. Keep `SsmPrefix` and `ResourceNamePrefix` on the application contract; do not let artifact prefixes rewrite DynamoDB/SQS/EventBridge names.

## Runtime contract

- CodeBuild: Node.js 22 (`aws/codebuild/standard:7.0`, `runtime-versions.nodejs: 22`)
- Lambda: `nodejs22.x`
- Serverless Framework: 3.40.0 (schema extended by `workflow/ci/plugins/allow-nodejs22-runtime.js`)

## RESOURCE_NAME_PREFIX propagation

```text
Common Stack parameter/derivation
  → CodePipeline variable ResourceNamePrefix
  → CodeBuild RESOURCE_NAME_PREFIX
  → service build/package (workflow/ci/generate-naming.sh)
  → nvdev-use1-mvx-workflow-service-db
    nvdev-use1-mvx-workflow-service-events
    nvdev-use1-mvx-workflow-service-bus
```

## IAM ownership

Pipeline, CodeBuild, CloudFormation deploy, and recovery roles are created and updated by this Common stack. Do not pre-create them with `deploy-pipeline.sh`.

## Data Preflight / Deploy-Data

Unchanged: Deploy-Data CodeBuild runs Data Preflight, then CREATE/UPDATE of the immutable data artifact, or prepares IMPORT recovery. That logic stays in the pipeline, not in `deploy-pipeline.sh`.
