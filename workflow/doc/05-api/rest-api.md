# REST API Specification — Workflow Runtime `/v1`

**Base path:** `/v1`  
**Auth:** Bearer JWT (platform IdP / Cognito). `organizationId` from token claim unless service role.  
**Content-Type:** `application/json`  
**Enums:** [`../03-domain/status-enums.md`](../03-domain/status-enums.md)  
**Errors:** standard envelope (below)  
**Idempotency:** `Idempotency-Key` header on mutating creates/complete/cancel (UUID/ULID). Replay returns prior result.  
**OCC:** `recordVersion` / `If-Match` on mutating instance/step/definition APIs (see below).  
**Step limit:** definitions and instances max **80** steps (`MAX_WORKFLOW_STEPS`) — see DB design.  
**List filters:** only combinations in [`filter-index-matrix.md`](filter-index-matrix.md); else `400`.

### Removed from REST (event-driven instead)

| Former client name | Replacement |
|--------------------|-------------|
| Implicit Care Plan start-only | Prefer `CarePlanWorkflowRequested` (REST start still available for manual) |

### Removed vs client name list

| Client name | Reconciled |
|-------------|------------|
| `UpdateWorkflowStatus` | Replaced by intent routes: `/start`, `/wait`, `/block`, `/resume`, `/complete`, `/cancel` |

---

## Common

### Error envelope

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Human readable",
    "details": [],
    "correlationId": "corr-…"
  }
}
```

| HTTP | When |
|------|------|
| 400 | Validation failure; **unsupported/ambiguous list filters** |
| 401 | Missing/invalid token |
| 403 | RBAC deny |
| 404 | Not found (org-scoped) |
| 409 | State conflict / duplicate active / idempotency mismatch / **`VERSION_CONFLICT`** |
| 412 | **Precondition failed** — `If-Match` present but does not match current `recordVersion` (alternate to 409; prefer **409** `VERSION_CONFLICT` for API consistency) |
| 428 | **Precondition required** — mutating API missing `If-Match` / `recordVersion` when required |
| 422 | Business rule (completion failed, skip not allowed, **step count > 80**) |
| 429 | Throttled |
| 500 | Unexpected |

### Pagination

Cursor: `?limit=25&cursor=<opaque>`  
Response: `{ "items": [...], "nextCursor": "..." | null }`

### Filtering

**Supported combinations only.** See [`filter-index-matrix.md`](filter-index-matrix.md).  
Unsupported or ambiguous filters → `400` with `UNSUPPORTED_FILTER` or `AMBIGUOUS_FILTER`. **No Scan fallback.**

### Optimistic concurrency (`recordVersion` / `If-Match`)

Applies to mutations on existing resources (not creates that allocate a new id, except as noted).

| Mechanism | Usage |
|-----------|--------|
| Response field | Every workflow METADATA, step, and definition version representation includes `recordVersion` (integer, starts at 1) |
| Response header | `ETag: W/"<recordVersion>"` (weak ETag) |
| Request header | `If-Match: W/"<recordVersion>"` **required** on listed mutations |
| Request body (alternative) | `"recordVersion": <n>` — accepted if `If-Match` absent; if both present they must agree |

**Required on:**

- `PUT` definition draft; `POST` publish / inactivate  
- `POST` workflow `assign`, `start`, `wait`, `block`, `resume`, `complete`, `cancel`  
- `POST` step `actions`, step `assign`  

**Not required on:**

- `POST` create definition / create workflow / clone (new resource)  
- `POST` notes / evidence (append-only; still reject if parent workflow is terminal via read of current status)  
- All `GET`s  

**Server behavior:**

1. Parse expected version from `If-Match` or body.  
2. DynamoDB `ConditionExpression`: `recordVersion = :expected`.  
3. On success: increment `recordVersion`, return new value + `ETag`.  
4. On condition failure: `409` `{ "code": "VERSION_CONFLICT" }`.  
5. On missing precondition for required endpoints: `428` `{ "code": "PRECONDITION_REQUIRED" }`.

Clients should: GET → mutate with returned `recordVersion` → on 409, re-GET and retry.

### Outbound domain events

Mutations that emit `WorkflowStarted` / `WorkflowCompleted` / `WorkflowCancelled` **persist an outbox item in the same TransactWrite**; EventBridge publish is asynchronous via Streams relay. HTTP success means state + outbox are durable, not that EventBridge has already delivered.

---

## A. Workflow Definitions (Admin) — RETIRED

> **Retired.** Design-time admin is Workflow Templates + Care Plan Mappings.
> Create path resolves templates only (`carePlanTemplateId` required).
> Legacy `WORKFLOW_DEF#` rows remain readable by the definition→template migration tools only.
> Do not add new Definition REST routes.

### Workflow template catalog metadata

Platform / org workflow templates persist optional Metadata Registry **value codes**
on the template `METADATA` item (not on runtime snapshots):

| API / DB field | Metadata type code | Example value |
|----------------|--------------------|---------------|
| `category` | `Category` | `CHRONIC` |
| `shareScope` | `SelectScope` | `ORGANIZATION` |
| `language` | `Language` | `ENGLISH` |
| `country` | `Country` | `IN` |

Dropdown options and labels come from `POST /metadata/values/by-types`
(`metadataTypeCodes: ["Category","SelectScope","Language","Country"]`).
This service stores the selected `metadataValueCode` only and never copies the catalog.

**Create / update / clone body (all optional):**

```json
{
  "category": "CHRONIC",
  "shareScope": "ORGANIZATION",
  "language": "ENGLISH",
  "country": "IN"
}
```

**List filters:** `GET .../workflow-templates?category=&shareScope=&language=&country=`
are post-query equality filters (same pattern as `program` / `condition` / `basedOn`).
Malformed codes → `400`. Templates without the attribute do not match a filter,
but remain listed when the filter is omitted.

### List / GET response — `createdByName` / `updatedByName`

`GET /v1/platform/workflow-templates`, `GET /v1/organizations/{orgId}/workflow-templates`,
and the matching template GET detail routes return the stored `createdBy` /
`updatedBy` user ids **and**, when resolvable from `USER_TABLE`, additive
`createdByName` / `updatedByName` display strings (same BatchGet enrichment
pattern as template-service Care Plan Templates). Lookup failures omit the
`*Name` fields and never fail the list or GET. Clients should prefer
`createdByName` / `updatedByName` for UI and fall back to the raw ids.

### Platform workflow template history

`GET /v1/platform/workflow-templates/{templateId}/history?limit=&cursor=`

**AuthZ:** none at API Gateway (custom authorizer Lambda is not attached)  
**Idempotency:** N/A (read)  
**Pagination:** `limit` 1–100 (default 50); opaque `cursor`  
**Ordering:** oldest → newest (`ScanIndexForward: true`), same as runtime `GET /v1/workflows/{id}/history`  
**Storage:** append-only items under the template PK with `SK = AUDIT#<historyId>` (same DynamoDB table; does not change METADATA / STEP / CHECKLIST)

**Actions written atomically with mutations:**

| Action | When |
|--------|------|
| `template.created` | Create (and clone → new template create) |
| `template.updated` | Update draft |
| `template.published` | Publish |
| `template.inactivated` | Inactivate |

`reason` is `null` until mutation APIs accept an optional changelog (not added in this release).  
Clone does **not** write history on the **source** template; the new template gets `template.created` only.  
Cross-template lineage is not implemented.

**Response `data`:** `{ items: WorkflowTemplateHistoryItem[], nextCursor }`  
**Errors:** 400 (bad query), 401/403 (auth), 404 (template not found)

---

### A1. Create definition (removed)

`POST /v1/workflow-definitions` — **removed**

**AuthZ:** `workflowDefinition:create`  
**Idempotency:** Yes  
**Validation:** `steps.length` ∈ 1..80; else `422` `MAX_STEPS_EXCEEDED`

**Request:**
```json
{
  "workflowType": "PATIENT_ONBOARDING",
  "name": "Standard Onboarding",
  "description": "…",
  "defaultAssignee": { "assigneeType": "role", "assigneeId": "careCoordinator" },
  "steps": [
    {
      "stepId": "verifyDemographics",
      "name": "Verify demographics",
      "instructions": "…",
      "requirement": "mandatory",
      "allowSkip": false,
      "allowDefer": false,
      "condition": null,
      "sortOrder": 1,
      "defaultAssignee": { "assigneeType": "role", "assigneeId": "careCoordinator" }
    }
  ]
}
```

**Response:** `201` definition summary (`definitionStatus: draft`, `version`, `recordVersion`)  
**Errors:** 400, 403, 409, 422

---

### A2. Update draft definition

`PUT /v1/workflow-definitions/{workflowType}/versions/{version}`

**AuthZ:** `workflowDefinition:update`  
**Validation:** only `draft`; `steps.length` ≤ 80  
**OCC:** `If-Match` / `recordVersion` **required**  
**Request:** same shape as create (replace steps)  
**Response:** `200` (includes new `recordVersion`)  
**Errors:** 404, 409 if not draft or version conflict, 422, 428

---

### A3. Publish definition

`POST /v1/workflow-definitions/{workflowType}/versions/{version}/publish`

**AuthZ:** `workflowDefinition:publish`  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` **required**  
**Validation:** step count ≤ 80  
**Effect:** status → `published`; prior published → `inactive`; set `PUBLISHED` pointer  
**Response:** `200`  
**Errors:** 404, 409, 422, 428

---

### A4. Inactivate definition version

`POST /v1/workflow-definitions/{workflowType}/versions/{version}/inactivate`

**AuthZ:** `workflowDefinition:inactivate`  
**OCC:** `If-Match` / `recordVersion` **required**  
**Response:** `200`  
**Errors:** 404, 409, 428

---

### A5. Get definition

`GET /v1/workflow-definitions/{workflowType}/versions/{version}`  
`GET /v1/workflow-definitions/{workflowType}/published` ← resolves pointer

**AuthZ:** `workflowDefinition:read`  
**Response:** `200` definition + steps  
**Errors:** 404

---

### A6. List definitions

`GET /v1/workflow-definitions?workflowType=&definitionStatus=&limit=&cursor=`

**AuthZ:** `workflowDefinition:read`  
**Filters:** [`filter-index-matrix.md`](filter-index-matrix.md) §3 — `workflowType` **required**  
**Response:** paginated summaries  
**Errors:** 400

---

### A7. Clone definition

`POST /v1/workflow-definitions/{workflowType}/versions/{version}/clone`

**AuthZ:** `workflowDefinition:create`  
**Idempotency:** Yes  
**Effect:** new `draft` version copied from source  
**Response:** `201`

---

## B. Workflow Instances (Runtime)

### B1. Start / create workflow (manual)

`POST /v1/workflows`

**AuthZ:** `workflow:start`  
**Idempotency:** Yes  

**Request:**
```json
{
  "workflowType": "FORMAL_REVIEW",
  "patientId": "pat-1",
  "carePlanId": "cp-1",
  "contextKey": "review-2026-Q3",
  "definitionVersion": null,
  "assignee": { "assigneeType": "user", "assigneeId": "usr-1" },
  "dueAt": "2026-08-01T00:00:00Z",
  "autoStart": true,
  "correlationId": "corr-…"
}
```

**Behavior:** Same pipeline as event create (uniqueness, steps ≤80, audit, outbox if autoStart). If `autoStart`, status `inProgress` and outbox `WorkflowStarted`.  
**Response:** `201` workflow aggregate (metadata + steps) including `recordVersion`  
**Errors:** 404 no published def, 409 duplicate active, 400, 403, 422 if definition has >80 steps

> Care Plan should prefer the event path; this supports admin/manual (FR-006).

---

### B2. Get workflow

`GET /v1/workflows/{workflowId}?include=steps,notes,evidence`

**AuthZ:** `workflow:read`  
**Response:** `200`  
`include=steps` returns each runtime step as snapshotted at create time, including optional `instructions`. Later template edits do not change existing instances.  
**Errors:** 404

---

### B3. List workflows

`GET /v1/workflows?patientId=&carePlanId=&workflowType=&workflowStatus=&assigneeId=&assigneeType=&dueBefore=&dueAfter=&overdue=&limit=&cursor=`

**AuthZ:** `workflow:read`  
**Filters:** **only** supported rows in [`filter-index-matrix.md`](filter-index-matrix.md) §1; else `400`  
**Response:** paginated  
**Errors:** 400

---

### B4. Assign workflow

`POST /v1/workflows/{workflowId}/assign`

**AuthZ:** `workflow:assign`  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` **required**  
**Request:** `{ "assigneeType": "user", "assigneeId": "usr-2", "reason": "…", "recordVersion": 3 }`  
**Validation:** workflow not terminal  
**Response:** `200` (new `recordVersion`)  
**Errors:** 404, 409, 403, 428

---

### B5. Start workflow (notStarted → inProgress)

`POST /v1/workflows/{workflowId}/start`

**AuthZ:** `workflow:update`  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` **required**  
**Response:** `200`  
**Side effect:** outbox `WorkflowStarted` if first transition to inProgress  
**Errors:** 409 invalid transition / version conflict, 428

---

### B6. Mark waiting

`POST /v1/workflows/{workflowId}/wait`  
**Request:** `{ "reason": "…" }` required  
**AuthZ:** `workflow:update`  
**OCC:** required  

### B7. Mark blocked

`POST /v1/workflows/{workflowId}/block`  
**Request:** `{ "reason": "…" }` required  
**AuthZ:** `workflow:update`  
**OCC:** required  

### B8. Resume (from waiting/blocked → inProgress)

`POST /v1/workflows/{workflowId}/resume`  
**AuthZ:** `workflow:update`  
**OCC:** required  

---

### B9. Complete workflow

`POST /v1/workflows/{workflowId}/complete`

**AuthZ:** `workflow:complete`  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` **required**  
**Request:**
```json
{
  "outcome": "completed",
  "finalNote": "…",
  "recordVersion": 4
}
```

**Validation:** completion evaluator; on failure `422` with `missingRequirements[]`  
**Side effect:** outbox `WorkflowCompleted.v1` (EventBridge via Streams relay)  
**Response:** `200` `{ workflow, completionSummary }`  
**Errors:** 409, 422, 403, 428

---

### B10. Cancel workflow

`POST /v1/workflows/{workflowId}/cancel`

**AuthZ:** `workflow:cancel`  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` **required**  
**Request:** `{ "reason": "…", "recordVersion": 4 }` required reason  
**Side effect:** outbox `WorkflowCancelled.v1`; cascade **all** steps in **one** TransactWrite (N≤80)  
**Response:** `200`  
**Errors:** 409 terminal / version conflict, 400, 403, 428

---

### B11. Get history

`GET /v1/workflows/{workflowId}/history?limit=&cursor=`

**AuthZ:** `workflow:read`  
**Response:** paginated audit items

---

## C. Steps

### C1. Update step (intent)

`POST /v1/workflows/{workflowId}/steps/{stepId}/actions`

**AuthZ:** `workflow:updateStep` (finer: skip/defer/block may require elevated)  
**Idempotency:** Yes  
**OCC:** `If-Match` / `recordVersion` on the **step** **required**  

**Request:**
```json
{
  "action": "complete",
  "reason": null,
  "note": "optional",
  "recordVersion": 2
}
```

`action`: `start` | `complete` | `wait` | `block` | `resume` | `skip` | `defer` | `cancel`

**Validation:** state machine + reason rules (FR-011)  
**Response:** `200` step (new `recordVersion`)  
**Errors:** 409, 422, 403, 404, 428

---

### C2. Assign step

`POST /v1/workflows/{workflowId}/steps/{stepId}/assign`  
Same body as workflow assign (+ step `recordVersion`).  
**AuthZ:** `workflow:assign`  
**OCC:** required on step  
**Note:** Step assignee is stored on the step item for display; Phase 1 queues are **workflow-level** (GSI3) only — see filter matrix.

---

### C3. Patient-level structure customisation

Lets a Care Manager tailor **one patient's runtime instance**. Platform / org
workflow templates, master & org care plans, and `CarePlanWorkflowMapping` are
never touched — only items under `ORG#<orgId>#WORKFLOW#<workflowId>`.

Definitions of existing steps / checklist items are **not** editable here: the
request bodies are strict, so rename / instruction / requirement / allowSkip /
allowDefer / assignee changes are rejected with `400`.

| Method | Path |
|--------|------|
| `POST` | `/v1/workflows/{workflowId}/steps` |
| `DELETE` | `/v1/workflows/{workflowId}/steps/{stepId}` |
| `POST` | `/v1/workflows/{workflowId}/steps/{stepId}/checklists` |
| `DELETE` | `/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}` |

**AuthZ:** Organization scope only (`custom:organizationID`), as on every other
workflow endpoint. Role enforcement is intentionally absent — see
[security.md](../08-security/security.md#role-enforcement-is-not-yet-wired).
**Idempotency:** No — OCC plus `attribute_not_exists` / `attribute_exists`
conditions already make retries safe
**OCC:** `If-Match` / `recordVersion` on the **workflow instance** **required**
(the instance version is the structure version). Response `ETag` carries the new
instance version.

**Add step request:**
```json
{
  "stepId": "device-setup",
  "name": "Device Setup",
  "requirement": "optional",
  "allowSkip": true,
  "allowDefer": true,
  "assigneeType": "role",
  "assigneeId": "careCoordinator",
  "sortOrder": 3
}
```
`sortOrder` defaults to the highest existing value + 1. New steps start at
`stepStatus = notStarted`.

**Add checklist request:**
```json
{
  "checklistId": "verify-device",
  "itemName": "Verify device installation",
  "instruction": "Confirm the device is installed",
  "required": true,
  "allowSkip": false,
  "allowDefer": false,
  "sortOrder": 2
}
```

**Lifecycle rule** (implementation decision — the requirements name no status
for structural edits; WF-FR-026 only bans edits on completed/cancelled):

| Workflow status | Add / remove |
|---|---|
| `notStarted` | allowed |
| `inProgress` | allowed |
| `waiting`, `blocked` | allowed |
| `completed` | `409 TERMINAL_WORKFLOW` |
| `cancelled` | `409 TERMINAL_WORKFLOW` |

**History rule:** only a `notStarted` step (whose checklist items are all
`notStarted`) and a `notStarted` checklist item may be removed; anything that
has executed returns `409 EXECUTION_HISTORY_PROTECTED`. Removing a step also
removes its checklist items. Audit rows, notes and evidence are never deleted.
A workflow must keep at least one step (`422`).

**Responses:** `201` add (`{ workflowId, recordVersion, step | checklist }`),
`200` remove (`{ workflowId, recordVersion, stepId, … }`)
**Errors:** 400, 403, 404, 409, 422, 428

---

## D. Notes & Evidence

### D1. Add workflow note

`POST /v1/workflows/{workflowId}/notes`  
**Body:** `{ "text": "…" }`  
**AuthZ:** `workflow:note`  
**Idempotency:** Yes  
**Response:** `201`  
**Reject if terminal:** `409`

### D2. Add step note

`POST /v1/workflows/{workflowId}/steps/{stepId}/notes`  
Same as D1.

### D3. Add evidence reference

`POST /v1/workflows/{workflowId}/steps/{stepId}/evidence`  
**Body:**
```json
{
  "refType": "labReport",
  "refId": "lab-123",
  "label": "CBC 2026-07-01"
}
```
**AuthZ:** `workflow:evidence`  
**Idempotency:** Yes  
**Response:** `201`  
**Note:** Does not fetch or copy domain payload.

### D4. List notes / evidence

`GET /v1/workflows/{workflowId}/notes`  
`GET /v1/workflows/{workflowId}/evidence?stepId=`

---

## E. UI / BFF projections

### E1. Dashboard summary

`GET /v1/dashboard/summary`

**AuthZ:** `workflow:read`  
**Response:**
```json
{
  "countsByType": { "PATIENT_ONBOARDING": { "inProgress": 3, "blocked": 1 } },
  "countsByStatus": { "waiting": 4, "blocked": 2, "overdue": 5 },
  "myOpenCount": 7
}
```

### E2. Workflow queue

`GET /v1/dashboard/queue?queue=my|overdue|blocked|waiting|onboardingPending|formalReviewDue|closureReviewDue&limit=&cursor=`

**AuthZ:** `workflow:read`  
**Filters:** [`filter-index-matrix.md`](filter-index-matrix.md) §2  
**Response:** paginated queue rows (id, type, patientId, carePlanId, status, dueAt, assignee, blockersSummary)  
**Errors:** 400 unknown/unsupported queue

### E3. Workbench context

`GET /v1/workflows/{workflowId}/workbench`

**AuthZ:** `workflow:read`  
**Response:** banner, steps tracker (includes snapshotted `instructions` and `linkedAction` when present, plus nested runtime `checklists[]` grouped by `stepId`; empty array when a step has none; includes `recordVersion`, `checklistStatus`, and `reason` when set by skip/defer/block/cancel), blockers, CTAs, progress `{ completed, totalApplicable }`, evidence refs. Checklists are the same runtime items as `GET /v1/workflows/{workflowId}/checklists` (status, `recordVersion`, sortOrder, blocking flags, reason).  
**Does not include** peer domain payloads (BFF loads those).

Checklist intent routes (runtime instance only): `.../checklists/{checklistId}/start|complete|skip|defer|block|resume|cancel|assign`. Block requires `reason` and is allowed only from `inProgress` → `blocked` (same state machine as steps). Skip and defer accept optional `reason`.  
**Parent step cascade:** checklist status mutations may automatically start (`notStarted`→`inProgress`) and/or complete (`inProgress`→`completed`) the parent step in the same TransactWrite when the existing step state machine and `evaluateChecklistCompletionReadiness` allow it. Checklist-driven UIs do not need separate step start/complete calls for normal progression; those step APIs remain available. Workflow complete stays an explicit `POST .../workflows/{workflowId}/complete`.

### E4. Completion readiness

`GET /v1/workflows/{workflowId}/completion-readiness`

**AuthZ:** `workflow:read`  
**Response:**
```json
{
  "ready": false,
  "missingRequirements": [
    { "stepId": "consent", "reason": "mandatory step not completed" }
  ],
  "blockingIssues": [{ "type": "workflowBlocked", "message": "…" }]
}
```

---

## F. Health

`GET /v1/health` — unauthenticated or gateway-only; liveness.

---

## Authorization permission catalog

| Permission | Used by |
|------------|---------|
| `workflowDefinition:create\|update\|publish\|inactivate\|read` | Admin APIs |
| `workflow:start\|read\|update\|assign\|complete\|cancel\|note\|evidence\|updateStep` | Runtime |
| Elevated: `workflow:skip`, `workflow:defer`, `workflow:block` | May map to same role in Phase 1 |

Role matrix: [`../08-security/security.md`](../08-security/security.md)
