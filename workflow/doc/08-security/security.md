# Security Model

## API Gateway authentication (runtime REST)

All `/v1` patient-runtime routes (including workbench **GET** and checklist
**POST** `.../complete|start|skip|defer|block|...`) currently have **no API
Gateway authorizer**. The shared Lambda
`*_global_user_package_custom_authorization` is not deployed in this account;
attaching it creates `CommonUnderscoreauthorizerLambdaPermissionApiGateway` and
fails Deploy-App with Function not found. `organizationId` is still resolved
from the JWT in app code when a Bearer token is present.

**Do not** set `authorizer: aws_iam` / `AuthorizationType: AWS_IAM` on these
routes. If API Gateway treats the method as IAM SigV4, a Cognito
`Authorization: Bearer <JWT>` produces:

`Invalid key=value pair (missing equal-sign) in Authorization header (hashed with SHA-256 and encoded with Base64)`

That message is **not** an application/idempotency/validation failure — it means
the **method auth type** (or the URL you hit) expects AWS SigV4, not Bearer JWT.
Workbench and checklist complete are identical in `serverless.yml`; if only one
fails, check live API Gateway method auth / wrong base URL / Postman auth type
(must be Bearer Token, not AWS Signature), then redeploy if the stage drifted.

## Authentication

| Mechanism | Usage |
|-----------|--------|
| Bearer JWT (platform Cognito / IdP) | All `/v1` APIs except health |
| Claims | `sub`, `organizationId` (or custom org claim), roles/permissions |
| Service-to-service | EventBridge/SQS IAM; no public invoke of consumer Lambda |

Reject requests where path/body `organizationId` disagrees with token org (unless platform admin role).

## Authorization (RBAC)

Permissions listed in [`../05-api/rest-api.md`](../05-api/rest-api.md).

### Phase 1 roles

| Role | Permissions (summary) |
|------|----------------------|
| `workflowAdmin` | All `workflowDefinition:*` |
| `careCoordinator` | `workflow:start,read,update,assign,complete,cancel,note,evidence,updateStep` + skip/defer/block |
| `clinician` | `workflow:read,update,note,evidence,updateStep,complete` (no cancel/start unless granted) |
| `supervisor` | careCoordinator + cancel + assign any + definition read |
| `readOnly` | `workflow:read`, `workflowDefinition:read` |

Exact role→permission mapping may use existing platform RBAC; this table is the Workflow capability set.

### Role enforcement is not yet wired

This table is the intended capability set, not what the service enforces today.
Workflow endpoints — including patient-level structure customisation (C3) —
authorise on **organization scope only**: a caller may act on any workflow in
the org named by their `custom:organizationID` claim.

Per-role enforcement is blocked on role resolution. Platform tokens carry
`custom:role` as an array of per-organization role **UUIDs**
(`["a3f46a0f-…"]`), never a role name, and `custom:permissions` is empty. The
name (`roleName` / `definedRoleCode`) lives in the external Role service
(`ROLE_API_URL`); see `apps/user-service/src/services/role.service.ts` for the
one existing resolver, `GET /org/{orgId}/users/{userId}/permissions`. Enforcing
roles here means calling that API per request, so it is deferred until the
platform settles on a shared authorizer.

## Ownership rules

- All items org-scoped via PK `ORG#<organizationId>#…`
- Users only see queues for their org
- Assignee filters for “My queue” use token `sub` as `assigneeId` when `assigneeType=user`
- Completed/cancelled: mutating APIs denied (`409`), notes/evidence denied

## Audit requirements

Every mutation writes `AUDIT#<ulid>` with: `action`, `actorId`, `actorType`, `timestamp`, `reason?`, `before?`, `after?`, `correlationId`.

Retain per NFR retention policy. Audit is immutable (no Update/Delete APIs).

## Sensitive data handling

| Data | Handling |
|------|----------|
| PHI in notes | Allowed but minimized; treat as PHI in logs — **do not** log note text at info |
| Evidence | IDs only; no lab payloads |
| Logs | `workflowId`, `organizationId`, `correlationId`, status — redact free text |
| Encryption | DynamoDB encryption at rest (AWS owned/CMK per platform); TLS in transit |
| PII in events | patientId/carePlanId as platform identifiers only |

## API gateway

- Authorizer required on protected routes
- WAF/rate limits per platform standard
- CORS per BFF origins only
