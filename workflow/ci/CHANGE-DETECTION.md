# Workflow Service change detection

Step 1 classifies a changed-file list into Data / Infra / App flags.

Step 2A wires that parser into the **Build** stage: current commit + last successful deployment commit → changed files → `detect-changes.sh` → deploy flags, and exports CodeBuild variables. `deployment-manifest.json` is written later by the Build/package step, not by change detection.

Step 2B connects those Build variables to CodePipeline V2 stage **EntryConditions** (`BeforeEntry` + `VariableCheck`) so unchanged deployment stages are **SKIPPED**.

Step 3 records the current source commit as `LAST_DEPLOYED_COMMIT` after the complete pipeline succeeds.

```text
Current Commit
      ↓
LAST_DEPLOYED_COMMIT
      ↓
Changed Files
      ↓
Deployment Decision
      ↓
Selective Deployment
      ↓
Validate / Smoke Test
      ↓
Record-Deployment
      ↓
LAST_DEPLOYED_COMMIT updated
```

`LAST_DEPLOYED_COMMIT` is updated only after successful completion of the pipeline. It is not “the latest commit that started the pipeline,” “the latest commit that passed Build,” or “the latest commit that passed Deploy-App.” Only Record-Deployment writes the parameter, and CodePipeline only starts that stage after every previous stage has succeeded (skipped stages are not failures).

```text
Build
  |
  |-- DEPLOY_DATA
  |-- DEPLOY_INFRA
  |-- DEPLOY_APP
  |
  +--> Deploy-Data
  |       condition: DEPLOY_DATA == true
  |       false → SKIP
  |
  +--> Deploy-Infra
  |       condition: DEPLOY_INFRA == true
  |       false → SKIP
  |
  +--> Validate-SSM
  |       always RUN
  |
  +--> Deploy-App
  |       condition: DEPLOY_APP == true
  |       false → SKIP
  |
  +--> Smoke-Test
  |       condition: DEPLOY_APP == true
  |       false → SKIP
  |
  +--> Record-Deployment
          always RUN when the pipeline reaches this stage
          writes LAST_DEPLOYED_COMMIT = current source commit
```

```bash
./apps/workflow-service/ci/test-detect-changes.sh
./apps/workflow-service/ci/test-detect-deployment-changes.sh
./apps/workflow-service/ci/test-codepipeline-entry-conditions.sh
./apps/workflow-service/ci/test-record-deployment.sh
./apps/workflow-service/ci/test-preflight-data.sh
```

---

## Step 1 — path parser

Standalone classifier. It does not talk to Git, SSM, or CodePipeline.

Script: [`detect-changes.sh`](./detect-changes.sh)

Tests: [`test-detect-changes.sh`](./test-detect-changes.sh)

### Input

Newline-separated repository paths from **stdin** or from a file:

```bash
./apps/workflow-service/ci/detect-changes.sh changed-files.txt
git diff --name-only origin/main...HEAD | ./apps/workflow-service/ci/detect-changes.sh
```

Paths may be service-relative (`src/handler.ts`) or repo-relative (`apps/workflow-service/src/handler.ts`). The parser does not check that files exist; it only classifies the path list.

### Output

Stdout includes a human-readable decision plus:

```text
DEPLOY_DATA=true|false
DEPLOY_INFRA=true|false
DEPLOY_APP=true|false
```

It also writes a JSON manifest. Set `DEPLOYMENT_MANIFEST` to change the location; the default is `deployment-manifest.json` in the current working directory.

```json
{
  "deployData": true,
  "deployInfra": false,
  "deployApp": true
}
```

### Path categories

Classification uses the first matching category. `README.md` and other documentation win over Data / Infra / CI/CD directories.

| Category | Paths | Layer flags after dependency rules |
|----------|--------|--------------------------------------|
| **Data** | `apps/workflow-service/data/**`, `config/data-*` (reserved for data-only config) | Data + App |
| **Infra** | `apps/workflow-service/infrastructure/**`, `config/infra-*.yml` | Infra + App |
| **App** | `src/**`, `serverless.yml`, `config/runtime-*.yml`, other app config (`config/app-custom.yml`, `config/permissions/**`, `config/ssm-paths.yml`, `config/resources/**`), remaining service-root runtime files (`swagger.json`, `tsconfig*`, `jest*`, `esbuild-plugins.js`) | App |
| **CI/CD** | `apps/workflow-service/ci/**` (except documentation), `buildspec.yml`, `stg-buildspec.yml`, `prd-buildspec.yml`, `package.json` | Data + Infra + App |
| **Docs** | `README.md` at any depth, `*.md`, `apps/workflow-service/doc/**`, repo `docs/**` | none |

Files outside this service (`libs/**`, other `apps/**`, shared `infra/**`) are ignored and do not set any flag.

There is no data-only YAML under `config/` today. `serverless.data.yml` lives under `data/`. `config/data-*` is reserved so a future data-only config file is classified as Data without treating all of `config/` as Data.

### Dependency rules

```text
Data change:   Data = true,  App = true
Infra change:  Infra = true, App = true
App change:    App = true
CI/CD change:  Data = true,  Infra = true, App = true
Docs-only:     Data = false, Infra = false, App = false
```

A Data change does **not** set Infra unless an Infra path is also present. An Infra change does **not** set Data unless a Data path is also present.

Mixed change sets union the flags. Docs in the same set as a deployable path do not suppress that path.

### Why CI/CD deploys all layers

`ci/**`, the stage buildspecs, and `package.json` can change packaging, IAM, deploy scripts, or Serverless/npm behavior for any of the three stacks. Step 1 therefore treats those paths as affecting every layer. Narrower CI/CD rules can wait until the parser is wired into the pipeline.

### Why docs-only deploys nothing

Markdown, README files, `doc/`, and repo `docs/` do not change CloudFormation templates or Lambda artifacts. They must not start Data, Infra, or App deploys. `README.md` under `data/`, `infrastructure/`, or `ci/` is still documentation.

### Examples

| Changed files | Data | Infra | App |
|---------------|------|-------|-----|
| `src/handler.ts` | false | false | true |
| `data/resources/data.yml` | true | false | true |
| `infrastructure/resources/sqs.yml` | false | true | true |
| `config/infra-dev.yml` | false | true | true |
| `config/runtime-dev.yml` | false | false | true |
| `ci/deploy-data.sh` | true | true | true |
| `package.json` | true | true | true |
| `README.md` | false | false | false |
| `docs/services/workflow-service/CICD.md` | false | false | false |
| `src/handler.ts` + `infrastructure/resources/sqs.yml` | false | true | true |
| `data/resources/data.yml` + `README.md` | true | false | true |

---

## Step 2A — Build integration

Script: [`detect-deployment-changes.sh`](./detect-deployment-changes.sh)

Tests: [`test-detect-deployment-changes.sh`](./test-detect-deployment-changes.sh)

Build resolves the current commit and runs change detection first, then packages Data, Infra, and App, then writes `deployment-manifest.json`. Packaging is unchanged. Step 2A does not skip stages; Step 2B does that with pipeline EntryConditions.

### Flow

```text
Build
  |
  +-- CURRENT_COMMIT
  |
  +-- detect-deployment-changes.sh
  |       |
  |       +-- LAST_DEPLOYED_COMMIT
  |       +-- changed files (baseline → current)
  |       +-- detect-changes.sh
  |       +-- export DEPLOY_DATA / DEPLOY_INFRA / DEPLOY_APP
  |
  +-- package Data
  +-- package Infra
  +-- package App
  |
  +-- generate deployment-manifest.json
  |
  +-- publish-artifacts.sh
  |
  +-- verify-artifacts.sh
```

### Current commit

Preferred source: `CODEBUILD_RESOLVED_SOURCE_VERSION` (CodeBuild / CodePipeline source revision).

Overrides: `CURRENT_COMMIT` if already set. `CODEBUILD_SOURCE_VERSION` is used only when it is already a Git SHA.

The value must be a Git commit SHA (7–40 hex characters). If it is missing or not a SHA, **Build fails**. The script does not silently deploy all, and it does not use `git rev-parse HEAD` as the only mechanism (CodePipeline `CODE_ZIP` artifacts often have no `.git` directory).

### Last successful deployment commit (SSM baseline)

Parameter (CI/CD namespace, not the application Data/Infra contract):

```text
/${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT
```

Examples: `/dev/workflow-service-cicd/LAST_DEPLOYED_COMMIT`, `/stg/...`, `/prd/...`.

The value is **only** the Git commit SHA of the last **successful** deployment. It is stored independently of Git history so the comparison is not `HEAD~1`.

**Build never writes this parameter.** A successful Build, a failed Build, or a successful parser run must not move the baseline. Only the **Record-Deployment** stage (Step 3) writes it, and only after the complete pipeline succeeds.

| SSM result | Behavior |
|------------|----------|
| `ParameterNotFound` | First deployment → deploy all layers |
| `AccessDeniedException` / bad credentials / other AWS errors | **Fail Build** — not treated as missing |

Do not hide AWS errors with `2>/dev/null`.

### First deployment

When `LAST_DEPLOYED_COMMIT` does not exist there is no reliable baseline. The script writes deploy-all flags to the decision env without calling `detect-changes.sh` and without writing `deployment-manifest.json`.

### Existing baseline

```text
changed files = files that differ between BASELINE_COMMIT and CURRENT_COMMIT
```

Multiple commits between deploys are included. If the last successful deploy was `A` and the build is `D` (`A → B → C → D`), the comparison is `A` to `D`, not only `C` to `D`.

The producer writes repository-relative paths (one per line) and passes that list to `detect-changes.sh`. Classification stays in the Step 1 parser.

### Changed-file comparison and CODE_ZIP limitation

Pipeline Source uses CodeStar + `OutputArtifactFormat: CODE_ZIP`. That zip is a snapshot **without Git history**, so `git diff <baseline> <current>` usually cannot run in CodeBuild today.

`compare_source_commits` is isolated in `detect-deployment-changes.sh`:

1. Tests / operators may set `CHANGED_FILES_LIST` to a path list and skip Git.
2. If a Git workspace contains both commits (local runs, or a future `CODEBUILD_CLONE_REF` source), the script uses `git diff --name-only <baseline> <current>`.
3. Otherwise Build **fails** with an explicit error. It does not call the GitHub compare API (this project has no repository credentials for that; the GitHub Packages npm token is not reused).

Until Record-Deployment has written `LAST_DEPLOYED_COMMIT` at least once, production Builds take the first-deployment path and do not need Git history. After the baseline exists, CodeBuild needs Git history (recommended: `CODEBUILD_CLONE_REF` on the existing CodeStar connection) or an injected file list.

### Manifest and exported variables

Change detection writes only `deployment-decision.env`. Build (`ci/build.sh`) writes `deployment-manifest.json` after packaging, using the same schema as before:

```json
{
  "service": "workflow-service",
  "stage": "dev",
  "currentCommit": "<git-sha>",
  "artifactBucket": "<ARTIFACT_BUCKET>",
  "artifactPrefix": "workflow-service/<git-sha>",
  "deployData": true,
  "deployInfra": false,
  "deployApp": true,
  "DEPLOY_DATA": true,
  "DEPLOY_INFRA": false,
  "DEPLOY_APP": true
}
```

Override location with `DEPLOYMENT_MANIFEST` (Buildspecs use `apps/workflow-service/deployment-manifest.json`). Default remains `deployment-manifest.json`.

CodeBuild `env.exported-variables`:

```text
DEPLOY_DATA=true|false
DEPLOY_INFRA=true|false
DEPLOY_APP=true|false
CURRENT_COMMIT=<git-sha>
```

The Build action namespace is `BuildVariables`. Step 2B reads `#{BuildVariables.DEPLOY_DATA}`, `#{BuildVariables.DEPLOY_INFRA}`, and `#{BuildVariables.DEPLOY_APP}`.

### IAM

Build role (`codebuild-workflow-service-role`) needs:

```text
ssm:GetParameter
on arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT
```

No `ssm:*`. No `ssm:PutParameter` on this parameter for Build. PutParameter is granted only to the Record-Deployment role (Step 3).

### Out of scope (Step 2A)

- Changing CloudFormation stack names, Data/Infra/App ownership, or application SSM names
- Lambda handlers or application/business logic
- GitHub compare API / extra GitHub credentials

---

## Step 2B — CodePipeline stage skipping

Template: [`codepipeline.yml`](./codepipeline.yml)

Tests: [`test-codepipeline-entry-conditions.sh`](./test-codepipeline-entry-conditions.sh)

Step 2B does **not** reclassify files. It only connects Step 2A Build output variables to native CodePipeline V2 stage EntryConditions.

### Pipeline type

The pipeline is `PipelineType: V2`. V2 is required for `BeforeEntry` (EntryConditions). Execution mode is unchanged (default `SUPERSEDED`). This is not a second pipeline.

### Build variable namespace

Unchanged:

```text
Build action namespace: BuildVariables
```

Conditions consume only:

```text
#{BuildVariables.DEPLOY_DATA}
#{BuildVariables.DEPLOY_INFRA}
#{BuildVariables.DEPLOY_APP}
```

### Stage EntryConditions

CloudFormation property: `BeforeEntry`. Each skippable stage has one condition:

| Stage | Variable | Rule | Operator / value | If the check fails |
|-------|----------|------|------------------|--------------------|
| Deploy-Data | `#{BuildVariables.DEPLOY_DATA}` | `VariableCheck` | `EQ` `true` | `Result: SKIP` |
| Deploy-Infra | `#{BuildVariables.DEPLOY_INFRA}` | `VariableCheck` | `EQ` `true` | `Result: SKIP` |
| Validate-SSM | (none) | — | — | always RUN |
| Deploy-App | `#{BuildVariables.DEPLOY_APP}` | `VariableCheck` | `EQ` `true` | `Result: SKIP` |
| Smoke-Test | `#{BuildVariables.DEPLOY_APP}` | `VariableCheck` | `EQ` `true` | `Result: SKIP` |
| Record-Deployment | (none) | — | — | always RUN |

A false deploy flag is an expected condition, not a pipeline failure. Do **not** use `FAIL` for that case.

CodePipeline evaluates the rule **before** the stage starts:

```text
flag == true  →  VariableCheck succeeds  →  stage RUNS
flag == false →  VariableCheck fails     →  Result SKIP  →  stage SKIPPED
```

A genuine Build failure still fails the pipeline. A genuine deploy failure still fails the pipeline.

Skipped stages do not run `deploy-data.sh`, the Infra/App CloudFormation actions, or the Smoke-Test project. Those implementations stay unaware of skip decisions.

### Validate-SSM stays unconditional

Order:

```text
Build → Deploy-Data → Deploy-Infra → Validate-SSM → Deploy-App → Smoke-Test → Record-Deployment
```

Validate-SSM always runs, including when Data and Infra were skipped. It is lightweight and checks the existing cross-stack SSM contract.

### Smoke-Test follows DEPLOY_APP

If App deployment is skipped, Smoke-Test is skipped. If App deploys, Smoke-Test runs.

### Deployment matrix

| Case | DATA | INFRA | APP | Build | Deploy-Data | Deploy-Infra | Validate-SSM | Deploy-App | Smoke-Test | Record-Deployment |
|------|------|-------|-----|-------|-------------|--------------|--------------|------------|------------|-------------------|
| 1 App-only | false | false | true | RUN | SKIP | SKIP | RUN | RUN | RUN | RUN |
| 2 Infra | false | true | true | RUN | SKIP | RUN | RUN | RUN | RUN | RUN |
| 3 Data | true | false | true | RUN | RUN | SKIP | RUN | RUN | RUN | RUN |
| 4 CI/CD | true | true | true | RUN | RUN | RUN | RUN | RUN | RUN | RUN |
| 5 Docs-only | false | false | false | RUN | SKIP | SKIP | RUN | SKIP | SKIP | RUN |
| 6 First deployment | true | true | true | RUN | RUN | RUN | RUN | RUN | RUN | RUN |

When all three flags are `true`, every stage runs. That is the same behavior as before Step 2B, plus Record-Deployment at the end.

CodePipeline does not encode Data→App or Infra→App dependencies. `detect-changes.sh` already sets `DEPLOY_APP=true` when Data or Infra must deploy.

Docs-only commits skip Data, Infra, App, and Smoke-Test, but **Record-Deployment still runs**. Otherwise documentation-only commits would stay outside the deployment baseline forever.

### Out of scope (Step 2B)

- GitHub history, GitHub tokens, Secrets Manager GitHub credentials, or changing the Source provider
- Skip wrappers inside `deploy-data.sh` / infra / app / smoke-test scripts
- Making Validate-SSM or Record-Deployment conditional
- Changing stack names or Buildspecs
- Lambda handlers or application/business logic

---

## Step 3 — successful deployment baseline update

Script: [`record-deployment.sh`](./record-deployment.sh)

Buildspec: [`record-deployment-buildspec.yml`](./record-deployment-buildspec.yml)

Tests: [`test-record-deployment.sh`](./test-record-deployment.sh)

Step 3 does **not** classify files or skip stages. It only writes the current source commit to SSM after the pipeline has already succeeded through Smoke-Test.

### Owner of the baseline

Only Record-Deployment may write:

```text
/${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT
```

Examples: `/dev/workflow-service-cicd/LAST_DEPLOYED_COMMIT`, `/stg/...`, `/prd/...`.

The value is **only** the Git commit SHA. It is not JSON.

Build remains read-only (`ssm:GetParameter`). Deploy-Data, Deploy-Infra, Validate-SSM, Deploy-App, and Smoke-Test do not write this parameter.

### When it runs

Record-Deployment is the last stage. It has **no** EntryCondition on `DEPLOY_DATA` / `DEPLOY_INFRA` / `DEPLOY_APP`.

```text
Build → Deploy-Data → Deploy-Infra → Validate-SSM → Deploy-App → Smoke-Test → Record-Deployment
```

`LAST_DEPLOYED_COMMIT` is updated only after successful completion of the pipeline.

If any earlier stage **fails**, CodePipeline does not start Record-Deployment, so `LAST_DEPLOYED_COMMIT` stays at the previous value.

Skipped stages are not failures. A docs-only run still reaches Record-Deployment and updates the baseline.

### Current commit

The Record-Deployment action receives the same commit identity Build already resolved:

```text
CURRENT_COMMIT=#{BuildVariables.CURRENT_COMMIT}
```

That value is the Git SHA `detect-deployment-changes.sh` resolved during Build (exported through the existing `BuildVariables` namespace). The script prefers this explicit `CURRENT_COMMIT`.

If `CURRENT_COMMIT` is missing, not a Git SHA (7–40 hex characters), or is an S3 artifact ARN/path, **Record-Deployment fails** and does **not** call PutParameter.

Do **not** treat `CODEBUILD_SOURCE_VERSION` as the commit. When Record-Deployment's input is not a Git source, CodeBuild sets that variable to an S3 artifact ARN (`arn:aws:s3:::.../BuildArtif/...`). That value must never be stored as `LAST_DEPLOYED_COMMIT`.

The script does not use `git rev-parse HEAD` as the only mechanism, and it does not pull/fetch a newer remote commit.

The Record-Deployment CodeBuild project receives `STAGE` and `AWS_REGION` explicitly. The pipeline action injects `CURRENT_COMMIT`; it is not a static commit value.

### SSM write

```text
aws ssm put-parameter
  --name /${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT
  --value <current commit SHA>
  --type String
  --overwrite
```

`Overwrite=true` makes the write idempotent: recording the same commit twice succeeds.

Do not hide AWS errors with `2>/dev/null`. AccessDenied, InvalidParameter, invalid region, or other AWS failures fail the stage, and the pipeline is not considered successful.

### IAM

Record-Deployment role (`{stage}-workflow-service-record-deployment-role`):

```text
ssm:PutParameter
on arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/${STAGE}/workflow-service-cicd/LAST_DEPLOYED_COMMIT
```

No `ssm:*`. No `ssm:DeleteParameter`. Build keeps `ssm:GetParameter` only.

### Failure behavior

| Earlier result | Record-Deployment | LAST_DEPLOYED_COMMIT |
|----------------|-------------------|----------------------|
| Deploy-Data fails | does not run | previous value |
| Deploy-Infra fails | does not run | previous value |
| Validate-SSM fails | does not run | previous value |
| Deploy-App fails | does not run | previous value |
| Smoke-Test fails | does not run | previous value |
| PutParameter fails | FAILED | previous value |
| All required stages succeed (including skips) | RUN | current commit |

Invariant:

```text
LAST_DEPLOYED_COMMIT
=
the current source commit of the most recent pipeline execution
that completed successfully through Record-Deployment
```
