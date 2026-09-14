# Step 1 — Conflict Inventory

All conflicts identified **before** reconciliation. Sources:

- **Client:** `Workflow Runtime Service.docx`
- **Designer:** Architecture plan, Architecture Diagram.png, Sequence Diagram, State Machine, DB Pattern, Event Contract

| ID | Conflict | Document A | Document B | Recommendation | Reason |
|----|----------|------------|------------|----------------|--------|
| C01 | Inbound event catalog: many triggers (`CarePlanActivated`, `CarePlanReviewDue`, `CarePlanClosureDue`, labs, alerts, …) vs single `CarePlanWorkflowRequested` | Client §6 | Architecture + Event Contract | **Phase 1:** single inbound `CarePlanWorkflowRequested` with `workflowType`. Map client Care Plan triggers into that event. Other inbound events → **Future**. | Care Plan owns when to start; one event avoids duplicate starters. Client §6 labeled events “suggested”. |
| C02 | Outbound catalog: many (`WorkflowAssigned`, `WorkflowBlocked`, …) vs only Completed/Cancelled (+ optional Started) | Client §6 | Architecture + Event Contract | **Phase 1:** `WorkflowStarted`, `WorkflowCompleted`, `WorkflowCancelled`. Others → **Future**. | Phase 1 visibility is dashboard-pull (client §8). Extra events add consumers with no Phase 1 requirement. |
| C03 | Workflow start: API **or** event (FR-006) vs event-only sequences | Client FR-006 | Sequences / Architecture diagram | Support **both**: event primary for Care Plan; `POST /v1/workflows` for manual/admin. | Honors client FR-006; keeps Care Plan async path. |
| C04 | Peer domain reads by Workflow (FR-018) vs BFF aggregates / adapters removed | Client FR-018 (+ note of uncertainty) | Architecture plan | **Phase 1:** BFF/UI pulls peer services. Workflow does **not** call peer domain HTTP. Evidence = references only. | Client already noted UI may own pulls; architecture correctly reduces coupling. |
| C05 | Notification requests in FR-029 vs Phase 1 dashboard-only | Client FR-029 / §8 | Architecture (no notification path) | **Phase 1:** no `WorkflowNotificationRequested`. Dashboard queues only. Future: notification event. | Explicit client §8: Phase 1 without staff notifications. |
| C06 | Status naming: PascalCase (`NotStarted`) vs SCREAMING_SNAKE (`CREATED`/`IN_PROGRESS`) | Client §4 | State Machine | **camelCase** wire values: `notStarted`, `inProgress`, … Align names to client meanings; drop `CREATED` in favor of `notStarted`. | Platform wire-format rule; client semantics preserved. |
| C07 | Workflow initial status: `NotStarted` vs `CREATED` | Client | State Machine | Use **`notStarted`**. | Client vocabulary is SoT for meaning. |
| C08 | Step status `Cancelled` in client vs omitted in state machine | Client FR-010 | State Machine transitions | **Include** `cancelled` for steps with defined transitions. | Client FR-010 / AC-010. |
| C09 | Step diagram shows `SKIPPED` → `IN_PROGRESS`; text says SKIPPED terminal | State Machine diagram | State Machine text | **`skipped` is terminal.** | Skipping completes the step disposition; resume is a different step action. |
| C10 | `DEFERRED` resumable in table vs diagram ambiguity | State Machine | State Machine | **`deferred` → `inProgress` allowed** (resume). Terminal only: `completed`, `skipped`, `cancelled`. | Matches client “Deferred … recorded for follow-up”. |
| C11 | Waiting/Blocked workflow: can cancel? | State Machine table allows | Diagram emphasis varies | Allow **cancel from waiting/blocked**. | Client cancel with reason; operational need. |
| C12 | Definition PK without org vs org-aware final update | DB Pattern (early) | DB Pattern (final) | **Org-aware** `ORG#<orgId>#WORKFLOW_DEF#<type>`. | Multi-tenant isolation. |
| C13 | GSI3 assignee: USER/ROLE/TEAM vs USER_ID only | DB early | DB final | Support **`assigneeType` + `assigneeId`** in PK. | Client assignment to user/role/team. |
| C14 | Overdue as `begins_with(OVERDUE#)` status | DB access patterns | State Machine (no OVERDUE status) | Overdue is a **query**, not a status: active statuses where `dueAt < now`. | Status model must stay clean. |
| C15 | `priority` in GSI SK never defined in requirements | DB Pattern | Client | Keep `priority` optional attribute; **remove from GSI SK**. SK = `status#dueAt#workflowId`. | Avoid undefined sort key segment. |
| C16 | Idempotency Guard mentioned; no persistence pattern | Architecture | DB Pattern | Add **idempotency items** with TTL. | Required for SQS at-least-once. |
| C17 | Duplicate active workflow uniqueness (FR-008) not in DB | Client FR-008 | DB Pattern | Add **uniqueness lock item** + conditional Put. | Enforce FR-008. |
| C18 | Event enum `PATIENT_ONBOARDING` vs camelCase platform | Event Contract | Platform / client PascalCase types | **Superseded:** Metadata Registry is SoT. Wire/DB/events use `PATIENT_ONBOARDING`, `FORMAL_REVIEW`, `CLOSURE_REVIEW`. | Catalog codes are SCREAMING_SNAKE (ADR-002 product/catalog exception). |
| C19 | Completion outcome / summary fields missing on `WorkflowCompleted` | Client FR-022/024 | Event Contract schema | Add `completionSummary`, `outcome`, step tallies. | Care Plan needs outcome. |
| C20 | API section is names-only; no paths/schemas | Client §5 | — | Publish full REST spec under `05-api/`. | Implementation readiness. |
| C21 | Generic `UpdateWorkflowStatus` vs intent-based transitions | Client §5 | State Machine engine | Prefer **intent endpoints** (`start`, `wait`, `block`, `resume`, `complete`, `cancel`). Keep no free-form status PATCH. | Prevents illegal transitions. |
| C22 | Sequence publishes `WorkflowStarted*`; Event Contract omits it | Sequences | Event Contract | **Include** `WorkflowStarted.v1` as Phase 1 outbound (after successful create). | Align sequences + optional architecture note. |
| C23 | Latest definition = “highest VERSION” ignores draft/inactive | DB Pattern | Client publish rules | **`PUBLISHED` pointer item** + version items with `definitionStatus`. | Only published starts instances (FR-003). |
| C24 | List definitions by type/status without access pattern | Client List API | DB Pattern | GSI or PK-per-type query + filter; add **DEF_LIST** GSI for org-wide list. | Support admin list API. |
| C25 | Audit retention / TTL unspecified | Architecture “immutable audit” | — | Immutable until retention; **TTL optional on idempotency only**; audit archive policy in NFR. | Compliance vs cost. |
| C26 | Optimistic locking / transactions unspecified | Sequences (multi-write) | DB Pattern | Document **TransactWrite** + **version** attribute OCC. | Atomic create/complete. |

## Conflict count

**26 conflicts** identified. All resolved in [`DECISIONS.md`](DECISIONS.md).
