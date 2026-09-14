# List / queue filter → index matrix

**Rule:** Every list/queue request must match exactly one supported row below.  
**Unsupported combinations → `400 Bad Request`** with `error.code = UNSUPPORTED_FILTER`.  
**Never Scan** the base table or a GSI to satisfy filters.

Indexes: see [`../04-persistence/db-design.md`](../04-persistence/db-design.md).

---

## 1. `GET /v1/workflows` (B3)

Optional params: `patientId`, `carePlanId`, `workflowType`, `workflowStatus`, `assigneeType`, `assigneeId`, `dueBefore`, `dueAfter`, `overdue`, `limit`, `cursor`.

| # | Required filters (all must be present) | Allowed extras | Forbidden if present | Index / operation | Notes |
|---|----------------------------------------|----------------|----------------------|-------------------|-------|
| W1 | `patientId` | `workflowStatus`, `workflowType`, `dueBefore`, `dueAfter`, `overdue`, `limit`, `cursor` | `carePlanId`, `assigneeType`, `assigneeId` | **GSI1** Query PK=`ORG#org#PATIENT#patientId` | Extra filters → `FilterExpression` only (same page); do not change index |
| W2 | `carePlanId` | same as W1 extras | `patientId`, `assigneeType`, `assigneeId` | **GSI2** Query | |
| W3 | `assigneeType` **and** `assigneeId` | `workflowStatus`, `dueBefore`, `dueAfter`, `overdue`, `limit`, `cursor` | `patientId`, `carePlanId`, `workflowType` | **GSI3** Query; if `workflowStatus` set → `begins_with(SK, status#)` | `workflowType` not supported on this path → 400 |
| W4 | `workflowStatus` (and **not** W1–W3) | `dueBefore`, `dueAfter`, `overdue`, `limit`, `cursor` | `patientId`, `carePlanId`, `assigneeType`, `assigneeId`, `workflowType` | **GSI4** Query PK=`ORG#org#STATUS#status` | Due bounds on SK `dueAt#workflowId` |
| W5 | `workflowType` (and **not** W1–W4) | `workflowStatus`, `limit`, `cursor` | `patientId`, `carePlanId`, `assignee*`, `dueBefore`, `dueAfter`, `overdue` | **GSI5** Query; optional `begins_with(SK, status#)` | Due/overdue not on GSI5 → 400 |
| W6 | `overdue=true` **and** `workflowStatus` ∈ active | `dueBefore` ignored (server uses `now`), `limit`, `cursor` | `patientId`, `carePlanId`, `assignee*`, `workflowType`, other statuses | **GSI4** Query SK `< now` | Active statuses: `notStarted`, `inProgress`, `waiting`, `blocked`. Client must pass **one** status per request (or call queue API) |
| W7 | *(none of the above)* | — | any data filter | — | **400** — must supply a supported key filter |

**Precedence when multiple keys present:** if more than one of {W1,W2,W3,W4/W5 key sets} could apply → **400** `AMBIGUOUS_FILTER` (client must narrow). Exception: `workflowStatus` may accompany W1–W3 as FilterExpression/SK prefix as listed.

**`overdue=true` without `workflowStatus`:** **400** — use `GET /dashboard/queue?queue=overdue` (server fans out per active status) or pass a single status (W6).

---

## 2. `GET /v1/dashboard/queue` (E2)

| `queue` value | Index / operation | Cursor |
|---------------|-------------------|--------|
| `my` | GSI3 PK=`ORG#org#ASSIGNEE#user#<token.sub>` | Yes |
| `blocked` | GSI4 PK=`…#STATUS#blocked` | Yes |
| `waiting` | GSI4 PK=`…#STATUS#waiting` | Yes |
| `overdue` | GSI4 × each active status with SK `< now`; **server-side merge by dueAt** for Phase 1 | Cursor encodes multi-partition state (opaque). Documented limitation; no Scan |
| `onboardingPending` | GSI5 PK=`…#TYPE#PATIENT_ONBOARDING` + FilterExpression status ∈ active | Yes |
| `formalReviewDue` | GSI5 `FORMAL_REVIEW` + FilterExpression active; optional dueAt filter | Yes |
| `closureReviewDue` | GSI5 `CLOSURE_REVIEW` + FilterExpression active; optional dueAt filter | Yes |

Unknown `queue` → **400**.

---

## 3. `GET /v1/workflow-definitions` (A6)

| Filters | Operation |
|---------|-----------|
| `workflowType` required | Base Query PK=`ORG#org#WORKFLOW_DEF#type`, `begins_with(VERSION#)` |
| `definitionStatus` optional | FilterExpression |
| Missing `workflowType` | **400** (Phase 1 — no org-wide def Scan) |

---

## 4. Nested lists (notes, evidence, history)

| Endpoint | Operation |
|----------|-----------|
| `GET /workflows/{id}/history` | Base Query `begins_with(AUDIT#)` |
| `GET /v1/platform/workflow-templates/{templateId}/history` | Base Query PK=`PLATFORM#WORKFLOW_TEMPLATE#id`, `begins_with(AUDIT#)`; oldest → newest |
| `GET /workflows/{id}/notes` | Base Query `begins_with(NOTE#)` |
| `GET /workflows/{id}/evidence` | Base Query `begins_with(EVIDENCE#)`; optional `stepId` → `begins_with(EVIDENCE#stepId#)` |

No alternate filters. Extra query params → **400**.

---

## 5. Implementation checklist

- [ ] Router selects matrix row before calling repository  
- [ ] Unit tests: each supported row + each 400 case  
- [ ] Integration tests assert Query (not Scan) via request metrics / logged `operation`  
- [ ] OpenAPI documents supported combinations only  
