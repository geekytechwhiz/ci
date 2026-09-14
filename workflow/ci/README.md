# Workflow Service CI scripts

CodePipeline owns deployment. Scripts in this folder are reused by the matching stage (or kept for manual/emergency use).

```text
ONE CODEPIPELINE  (workflow-service-pipeline, V2)
    ↓
Build              ci/build.sh + ci/verify-artifacts.sh   (this Build CodeBuild project)
    ↓
Deploy-Data        ci/preflight-data.sh + ci/deploy-data.sh   SKIP unless #{BuildVariables.DEPLOY_DATA}=true
                   RECOVERY_REQUIRED prepares an IMPORT change set and succeeds (does not execute it)
    ↓
Approve-Data-Recovery   Manual approval. SKIP unless #{DataDeploymentVariables.RECOVERY_REQUIRED}=true
    ↓
Recover-Data       IMPORT WorkflowTable, then full Data UPDATE from the commit-scoped artifact.
                   SKIP unless #{DataDeploymentVariables.RECOVERY_REQUIRED}=true
    ↓
Deploy-Infra       ci/deploy-infra.sh                     SKIP unless #{BuildVariables.DEPLOY_INFRA}=true
    ↓
Validate-SSM       ci/validate-ssm.sh                     always runs
    ↓
Deploy-App         ci/deploy-app.sh                       SKIP unless #{BuildVariables.DEPLOY_APP}=true
    ↓
Smoke-Test         ci/smoke-test.sh                       SKIP unless #{BuildVariables.DEPLOY_APP}=true
    ↓
Record-Deployment  ci/record-deployment.sh                always runs; writes LAST_DEPLOYED_COMMIT
```
 
| Script | Pipeline use | Manual use |
|--------|----------------|------------|
| `build.sh` | Build stage (package + generate `deployment-manifest.json`) | Package all three stacks locally; write the commit-scoped manifest when `CURRENT_COMMIT` is set |
| `verify-artifacts.sh` | Build POST_BUILD | Confirm Lambda zips and commit-scoped templates exist in `ARTIFACT_BUCKET` |
| `preflight-data.sh` | Deploy-Data CodeBuild (once, before CloudFormation) | Primary read-only classifier: `CREATE` / `UPDATE` / `RECOVERY_REQUIRED` / `STOP`. Validates the commit-scoped Data artifact, stack, and WorkflowTable. Writes `deployment-data-preflight.env`. Does not import or modify the table. |
| `deploy-data.sh` | Deploy-Data CodeBuild | Consumes `deployment-data-preflight.env`. Create or update `{stage}-workflow-service-data`. Stops on `STOP`. Does **not** re-run full preflight when the env file exists. Does **not** CloudFormation IMPORT. `RECOVERY_REQUIRED` is routed by the buildspec to `recover-data.sh` (prepare). A CREATE-only `describe-table` check is a TOCTOU safety guard, not a second classification. |
| `recover-data.sh` | Deploy-Data (prepare) and Recover-Data (execute) | Orchestrates IMPORT-only change set preparation, then after approval executes IMPORT and a normal full Data UPDATE from `s3://$ARTIFACT_BUCKET/workflow-service/$CURRENT_COMMIT/data/packaged.yaml`. |
| `prepare-data-recovery.sh` | Deploy-Data via `recover-data.sh` prepare | Creates and machine-validates an IMPORT change set for `WorkflowTable` only. Does not execute it. |
| `execute-data-recovery.sh` | Recover-Data after approval | The only component that executes the IMPORT change set. Waits for `IMPORT_COMPLETE`. |
| `complete-data-recovery.sh` | Recover-Data after IMPORT | Normal CloudFormation UPDATE of the full immutable Data template. Recreates non-retained Data resources (SSM contract) via CloudFormation. |
| `validate-ssm.sh` | Validate-SSM CodeBuild (BuildArtifact) | Gate before a manual app deploy (`TABLE_*`, `STREAM_ARN`, `SQS_QUEUE_*`) |
| `smoke-test.sh` | Smoke-Test CodeBuild (BuildArtifact) | Confirm `GET /health` after a manual app deploy |
| `deploy-infra.sh` | Deploy-Infra CodeBuild | Emergency/recurring infra deploy of `{stage}-workflow-service-infra` from the commit-scoped artifact |
| `deploy-app.sh` | Deploy-App CodeBuild | Emergency app deploy of `{stage}-workflow-service` from the commit-scoped artifact (includes EventBus/SQS ownership guard) |
| `publish-artifacts.sh` | Build (after package + manifest generation) | Upload immutable templates to `s3://$ARTIFACT_BUCKET/workflow-service/<commit-sha>/`. Does not generate the manifest. |
| `common.sh` | Sourced by the scripts above | Shared names, SSM list, S3 SSE-S3 upload helper |
| `detect-changes.sh` | Build (via `detect-deployment-changes.sh`) | Classify a changed-file list into Data / Infra / App flags. See [CHANGE-DETECTION.md](./CHANGE-DETECTION.md) |
| `detect-deployment-changes.sh` | Build (before package) | Read SSM `LAST_DEPLOYED_COMMIT`, resolve current commit, produce the changed-file list, call `detect-changes.sh`, export `DEPLOY_DATA` / `DEPLOY_INFRA` / `DEPLOY_APP`. Does **not** write `deployment-manifest.json`. Does **not** skip stages itself (Step 2B EntryConditions do). Does **not** update the SSM baseline. |
| `record-deployment.sh` | Record-Deployment CodeBuild (SourceArtifact + `CURRENT_COMMIT=#{BuildVariables.CURRENT_COMMIT}`) | Write the current source commit SHA to `/${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT`. The only writer of that parameter. |
| `test-detect-changes.sh` | **Not** used by CodePipeline | Local tests for `detect-changes.sh` |
| `test-detect-deployment-changes.sh` | **Not** used by CodePipeline | Local tests for `detect-deployment-changes.sh` (mocked AWS) |
| `test-codepipeline-entry-conditions.sh` | **Not** used by CodePipeline | Local tests for V2 `BeforeEntry` skip conditions and Record-Deployment placement in `codepipeline.yml` |
| `test-record-deployment.sh` | **Not** used by CodePipeline | Local tests for `record-deployment.sh` (mocked AWS) and Record-Deployment IAM |
| `test-publish-artifacts.sh` | **Not** used by CodePipeline | Local tests for commit-scoped artifact publish/fetch |
| `test-preflight-data.sh` | **Not** used by CodePipeline | Local tests for `preflight-data.sh` (mocked AWS) and Data deploy gating |
| `test-prepare-data-recovery.sh` | **Not** used by CodePipeline | Local tests for IMPORT change set preparation |
| `test-execute-data-recovery.sh` | **Not** used by CodePipeline | Local tests for IMPORT execution after approval |
| `test-complete-data-recovery.sh` | **Not** used by CodePipeline | Local tests for the post-import full Data UPDATE |
| `test-recover-data.sh` | **Not** used by CodePipeline | Local tests for the recovery orchestrator and pipeline variable wiring |
| `test-recover-data-iam.sh` | **Not** used by CodePipeline | Policy validation for dedicated Data recovery IAM (DynamoDB import allow, unrelated import deny, no `DeleteTable`, no unrelated S3, no unrestricted IAM) |
| `test-smoke-test.sh` | **Not** used by CodePipeline | Local tests for `smoke-test.sh` (mocked curl/AWS) and Smoke-Test IAM |

`deploy-data.sh` and `deploy-infra.sh` fail immediately if CloudFormation deploy fails. Data preflight `STOP` fails Deploy-Data so Infra and App do not run. `RECOVERY_REQUIRED` prepares an IMPORT change set and **succeeds** Deploy-Data so Approve-Data-Recovery can run; recovery is not executed until approval. They do not hide errors with `|| true`.

## Buildspecs

| File | Stage |
|------|--------|
| `../buildspec.yml` | Build (dev) — package only |
| `../stg-buildspec.yml` | Build (stg) — package only |
| `../prd-buildspec.yml` | Build (prd) — package only |
| `deploy-data-buildspec.yml` | Deploy-Data |
| `recover-data-buildspec.yml` | Recover-Data |
| `deploy-infra-buildspec.yml` | Deploy-Infra |
| `deploy-app-buildspec.yml` | Deploy-App |
| `validate-ssm-buildspec.yml` | Validate-SSM |
| `smoke-test-buildspec.yml` | Smoke-Test |
| `record-deployment-buildspec.yml` | Record-Deployment |
| `codepipeline.yml` | Optional CloudFormation for the pipeline + stage CodeBuild projects + IAM |

Do not add CloudFormation deploy permissions to `codebuild-workflow-service-role` to make the old POST_BUILD path work. That path is removed.
