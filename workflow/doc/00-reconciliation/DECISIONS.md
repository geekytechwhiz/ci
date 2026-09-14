# Step 2 — Binding Design Decisions

These decisions are **final** for Phase 1. All other docs must match them.

**Client document** (`Workflow Runtime Service.docx`) is the functional source for *what* the product must do. Designer docs supply *how*. Where designer docs narrowed Phase 1 for delivery, that narrowing is recorded here and reflected as **Phase 1** vs **Future** in requirements.

---

## D01 — Single Source of Truth

**Decision:** Markdown pack under `apps/workflow-service/doc/**` (this tree) is authoritative. Legacy `.docx` / `.png` are historical (see `LEGACY.md`).

**Why:** Word artifacts contradicted each other; one editable SoT is required before coding.

---

## D02 — Ownership boundary

**Decision:** Workflow Runtime owns definitions, instances, steps, assignment, notes, evidence **references**, completion validation, queue/workbench **workflow** projections, and audit. Peer services own their domain records. **BFF** aggregates Monitoring, Labs, Goals, Alerts, Appointments, Documents, Devices for workbench panels.

**Why:** Client §3 boundary rules + architecture “adapters removed”. Client FR-018 note already questioned backend peer pulls.

**Implication:** FR-018 Phase 1 = **not implemented** as Workflow→peer HTTP. Marked Future/optional if ever needed for server-side validation.

---

## D03 — Workflow creation

**Decision:**
1. **Primary:** Inbound event `CarePlanWorkflowRequested.v1` (Care Plan Runtime).
2. **Secondary:** `POST /v1/workflows` for authorized manual/admin start (same create pipeline).

**Why:** Honors client FR-006 while keeping Care Plan lifecycle event-driven (architecture).

---

## D04 — Event catalog (Phase 1)

**Inbound (Phase 1):**
| Event | Version |
|-------|---------|
| `CarePlanWorkflowRequested` | v1 |

Care Plan maps activated / review-due / closure-due **internally** into this one event via `workflowType`.

**Outbound (Phase 1):**
| Event | Version |
|-------|---------|
| `WorkflowStarted` | v1 |
| `WorkflowCompleted` | v1 |
| `WorkflowCancelled` | v1 |

**Future (documented, not implemented in Phase 1):**  
`AppointmentCompleted`, `LabReportUploaded`, `AlertResolved`, `MonitoringStatusUpdated`, `WorkflowNotificationDelivered` (in);  
`WorkflowAssigned`, `WorkflowStepCompleted`, `WorkflowBlocked`, `WorkflowWaiting`, `WorkflowNotificationRequested` (out).

**Why:** Resolves C01/C02/C05/C22. Matches client §8 dashboard-first Phase 1 and architecture slim integration surface.

---

## D05 — Status enums (one set)

**Wire + DynamoDB attribute values: camelCase.**

### Workflow status
`notStarted` | `inProgress` | `waiting` | `blocked` | `completed` | `cancelled`

### Step status
`notStarted` | `inProgress` | `waiting` | `blocked` | `completed` | `skipped` | `deferred` | `cancelled`

### Definition status
`draft` | `published` | `inactive`

### Workflow type
`PATIENT_ONBOARDING` | `FORMAL_REVIEW` | `CLOSURE_REVIEW` (Metadata Registry catalog codes; not camelCased)

### Assignee type
`user` | `role` | `team`

**Why:** Platform wire-format rule (C06/C18). Client meanings preserved; `CREATED` renamed to `notStarted` (C07). Step `cancelled` included (C08).

---

## D06 — Intent-based workflow APIs (no free status PATCH)

**Decision:** Do **not** expose `UpdateWorkflowStatus` as arbitrary status write. Expose:

- start (notStarted→inProgress)
- wait / block / resume
- complete / cancel
- step status updates via dedicated step action API with transition validation

**Why:** State Transition Engine must own legality (C21).

---

## D07 — Notifications

**Decision:** Phase 1 = dashboard/queue pull only. No outbound notification event. No direct SMS/email/push from Workflow (FR-030 stands).

**Why:** Client §8.

---

## D08 — Database

**Decision:** Single-table DynamoDB with org-scoped keys; GSI1–GSI5 as specified in `04-persistence/db-design.md`; uniqueness lock; idempotency items + TTL; PUBLISHED pointer; overdue via dueAt query (not a status); TransactWrite + OCC `recordVersion`. Extended by **D13–D16** (outbox, max steps, filter matrix, If-Match) without adding/removing GSIs.

**Why:** Resolves C12–C17, C23–C26; production hardening without schema redesign.

---

## D09 — API versioning

**Decision:** All HTTP under `/v1/`. Standard error envelope. Cursor pagination on lists. Cognito JWT (or platform IdP) + org claim. RBAC per `08-security/`.

**Why:** Platform REST conventions; closes C20.

---

## D10 — Completion outcome

**Decision:** `WorkflowCompleted.v1` includes `completionSummary`, `outcome`, and step counts. `CompleteWorkflow` API returns the same summary.

**Why:** FR-022/024 (C19).

---

## D11 — Duplicate active instances

**Decision:** At most one **active** (non-`completed`, non-`cancelled`) instance per `(organizationId, patientId, carePlanId, workflowType, contextKey)`. `contextKey` defaults to `default` or Care Plan–supplied review/closure cycle id.

**Why:** FR-008.

---

## D12 — Wire format for events

**Decision:** Event `detail-type` may remain PascalCase+version suffix (e.g. `CarePlanWorkflowRequested.v1`). Payload fields and enum values are camelCase.

**Why:** Platform exception for detail-type naming; payload follows camelCase rule.

---

## D13 — Transactional outbox for egress (production hardening)

**Decision:** Persist `OutboxEvent` in the **same** `TransactWrite` as workflow start/complete/cancel. Publish to EventBridge via **DynamoDB Streams relay** (not synchronous PutEvents on the request path). No new GSIs.

**Why:** Prevents dual-write loss between DynamoDB commit and EventBridge for Care Plan handoff.

---

## D14 — Phase 1 max steps = 80 (production hardening)

**Decision:** Hard limit `MAX_WORKFLOW_STEPS = 80` on definitions and instances. Create and cancel **must** use a single `TransactWriteItems`. Chunked cancel is forbidden.

**Why:** DynamoDB transact max 100 items; budget N+5 (create) / N+4 (cancel) with outbox stays ≤ 100.

---

## D15 — List filter → index matrix (production hardening)

**Decision:** Only filter combinations documented in `05-api/filter-index-matrix.md` are allowed. All others return `400`. No Scan fallback.

**Why:** Prevents accidental table scans and undefined access patterns under combined filters.

---

## D16 — OCC via recordVersion / If-Match (production hardening)

**Decision:** Mutating APIs on existing workflow/step/definition resources require `If-Match: W/"<recordVersion>"` or body `recordVersion`. Mismatch → `409 VERSION_CONFLICT`; missing → `428 PRECONDITION_REQUIRED`.

**Why:** Makes optimistic locking usable by clients; avoids silent last-write-wins.
