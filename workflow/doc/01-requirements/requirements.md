# Reconciled Requirements — Workflow Runtime Service

Derived from client `Workflow Runtime Service.docx`, annotated for **Phase 1** vs **Future** per [`../00-reconciliation/DECISIONS.md`](../00-reconciliation/DECISIONS.md).

Enum values in this document use **camelCase** (reconciled). Original client PascalCase names are synonyms only.

---

## 1. Purpose

The Workflow Runtime Service manages configurable, structured, multi-step care operations that require staff to follow defined steps, rules, blockers, evidence capture, and completion criteria.

**Phase 1** supports: Patient Onboarding, Formal Review, and Closure Review for care plans.

It is not a generic ticketing system and does not replace Task Runtime, Alert Service, Care Plan Runtime, Appointment, Payment, or other domain services.

---

## 2. Scope

### 2.1 In scope (Phase 1)

| # | Capability | Notes |
|---|------------|-------|
| 1 | Patient Onboarding workflow | After doctor activates care plan (via Care Plan event) |
| 2 | Formal Review workflow | When review is due or manually started |
| 3 | Closure Review workflow | When care plan ready for closure |
| 4 | Workflow instance creation | Event + REST manual start |
| 5 | Workflow step management | Status, owner, due, blocker, reason |
| 6 | Mandatory / optional / conditional steps | Per definition |
| 7 | Skip / defer / block / waiting | Reason required where applicable |
| 8 | Notes and evidence references | References only — no domain copy |
| 9 | Assignment | User / role / team |
| 10 | Completion validation | Block complete if rules fail |
| 11 | Completion outcome | Event to Care Plan Runtime |
| 12 | Dashboard / workbench support | Summaries, queues, readiness |
| 13 | Audit / history | Actor, timestamp, reason |
| 14 | Definition admin | Draft / publish / inactivate / clone |

### 2.2 Explicitly out of Phase 1 (Future)

| Capability | Client reference | Notes |
|------------|------------------|-------|
| Staff push notifications | FR-029, §8 Future | Dashboard-only in Phase 1 |
| Peer-domain HTTP from Workflow | FR-018 | BFF aggregates (D02) |
| Extra inbound domain events | §6 | Labs/alerts/appointments → Future |
| Extra outbound workflow events | §6 | Assigned/Blocked/Waiting/StepCompleted → Future |
| Non–care-plan workflow types | Purpose | Extensibility preserved in model |

---

## 3. Related services

| Service | Relationship (Phase 1) |
|---------|------------------------|
| Care Plan Runtime | Publishes `CarePlanWorkflowRequested`; consumes Completed/Cancelled |
| Portal / BFF | Calls Workflow REST; aggregates peer domain data for UI |
| Admin / Configuration UI | Manages definitions via REST |
| Task / Monitoring / Goals / Symptoms / Alert / Appointment / Lab / Document / Device | **Not called by Workflow.** BFF/UI may call them. Evidence stores IDs only |
| Notification / Scheduler | **Not integrated in Phase 1** |

### Boundary rules (binding)

| Rule | Requirement |
|------|-------------|
| Workflow owns steps | Step status managed inside Workflow Runtime |
| Task is optional | Task Runtime is not the step engine |
| No continuous sync | Peers do not push every status change to Workflow |
| BFF pulls context | Workbench domain panels come from peer APIs via BFF |
| No domain ownership | Workflow does not own readings, goals, alerts, labs, etc. |
| Store references only | Evidence = reference IDs + optional summary note |

---

## 4. Definitions & enums

See [`../03-domain/status-enums.md`](../03-domain/status-enums.md) for the single enum SoT.

| Term | Definition |
|------|------------|
| Workflow Definition | Admin-configured template (steps, rules, ownership, completion criteria) |
| Workflow Instance | Runtime workflow for patient + care plan context |
| Workflow Step | Step inside an instance |
| Evidence Reference | Link to external record (lab, alert, reading, …) without copying payload |
| Blocker | Issue preventing progress |
| Context key | Discriminator for uniqueness of active instance (e.g. review cycle id) |

---

## 5. Functional requirements (annotated)

| ID | Requirement | Phase |
|----|-------------|-------|
| WF-FR-001 | Authorized admin can create definitions in `draft` | Phase 1 |
| WF-FR-002 | Definitions include ordered steps, owner, instructions, mandatory/optional/conditional, completion criteria | Phase 1 |
| WF-FR-003 | Only `published` definitions used for instance creation | Phase 1 |
| WF-FR-004 | Reject start when no published definition for type/org | Phase 1 |
| WF-FR-005 | Types: `PATIENT_ONBOARDING`, `FORMAL_REVIEW`, `CLOSURE_REVIEW` | Phase 1 |
| WF-FR-006 | Create instance from **event or API** | Phase 1 |
| WF-FR-007 | Create step instances from published definition | Phase 1 |
| WF-FR-008 | Prevent duplicate **active** instance for same org/patient/carePlan/type/contextKey | Phase 1 |
| WF-FR-009 | Workflow status independent of care plan status | Phase 1 |
| WF-FR-010 | Step statuses per enum SoT (includes `cancelled`) | Phase 1 |
| WF-FR-011 | Reason required for waiting/blocked/skipped/deferred/cancelled | Phase 1 |
| WF-FR-012 | Authorized users update step status per allowed transitions | Phase 1 |
| WF-FR-013 | Reject invalid transitions | Phase 1 |
| WF-FR-014 | Assign workflow or step to user/role/team | Phase 1 |
| WF-FR-015 | Reassignment permitted; retain history (audit) | Phase 1 |
| WF-FR-016 | Notes at workflow and step level | Phase 1 |
| WF-FR-017 | Evidence references without copying source records | Phase 1 |
| WF-FR-018 | Retrieve status from related services when step needs validation | **Future** (BFF in Phase 1) |
| WF-FR-019 | Prevent complete until mandatory steps satisfied (completed/skipped-allowed/deferred-allowed) | Phase 1 |
| WF-FR-020 | Optional steps need not be complete | Phase 1 |
| WF-FR-021 | Evaluate conditional steps only when condition applies | Phase 1 |
| WF-FR-022 | Generate completion summary on complete | Phase 1 |
| WF-FR-023 | Publish `WorkflowCompleted` after success | Phase 1 |
| WF-FR-024 | Send completion outcome to Care Plan Runtime | Phase 1 |
| WF-FR-025 | Cancel with required reason | Phase 1 |
| WF-FR-026 | No normal edits to completed/cancelled instances | Phase 1 |
| WF-FR-027 | Queue/dashboard summaries by type, status, owner, due, blocked, overdue | Phase 1 |
| WF-FR-028 | Workbench context: banner, steps, blockers, CTAs, readiness | Phase 1 |
| WF-FR-029 | Request notifications when assigned/due/overdue/waiting/blocked | **Future** |
| WF-FR-030 | Must not send SMS/email/push/in-app directly | Phase 1 (always) |
| WF-FR-031 | History for create, assign, step updates, notes, evidence, complete, cancel | Phase 1 |
| WF-FR-032 | RBAC for create, assign, update step, skip, defer, block, complete, cancel | Phase 1 |
| WF-FR-033 | Save/resume — preserve progress until complete/cancel | Phase 1 |
| WF-FR-034 | Expose missing requirements on incomplete complete attempt | Phase 1 |
| WF-FR-035 | Support future workflow types without changing core engine | Phase 1 (model) |
| WF-FR-036 | Care Manager may add/remove a step and add/remove a checklist item on a patient's runtime instance; existing step/checklist definitions stay read-only and templates are untouched | Phase 1 (authorised by org scope; per-role check pending platform role resolution) |
| WF-FR-037 | Structural add/remove allowed on non-terminal instances only; a step/checklist item that has left `notStarted` cannot be removed | Phase 1 (implementation rule — client text names no status) |

---

## 6. Acceptance criteria (Phase 1)

AC-001 … AC-016, AC-018 … AC-030 from client remain in force with camelCase enums and Phase 1 annotations above.

| ID | Change vs client text |
|----|----------------------|
| AC-017 | **Deferred (Future)** — peer status retrieval by Workflow; BFF owns in Phase 1 |
| AC-025 | Confirmed — dashboard pull, no staff notifications |
| Enums | Interpret all status names as camelCase equivalents |

---

## 7. UI requirements

Client §9 UI requirements (Admin, Dashboard, Workbench, WF-UI-001…008) remain in force. APIs that support them are in [`../05-api/rest-api.md`](../05-api/rest-api.md).
