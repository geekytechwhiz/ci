# State Machines (Single SoT)

Engine: **State Transition Engine** validates every transition.  
Invalid transition → `409 Conflict` (state conflict) or `422 Unprocessable Entity` (business rule).  
Every successful transition appends an immutable **audit** item.

Enums: [`status-enums.md`](status-enums.md)

---

## 1. Workflow state machine

### Transitions

| From | To | Trigger (API / system) | Guards |
|------|----|------------------------|--------|
| `notStarted` | `inProgress` | `POST .../start` or auto-start policy on create | Definition published; instance active |
| `notStarted` | `cancelled` | `POST .../cancel` | Reason required |
| `inProgress` | `waiting` | `POST .../wait` | Reason required |
| `inProgress` | `blocked` | `POST .../block` | Reason required |
| `inProgress` | `completed` | `POST .../complete` | Completion evaluator passes; not blocked |
| `inProgress` | `cancelled` | `POST .../cancel` | Reason required |
| `waiting` | `inProgress` | `POST .../resume` | — |
| `waiting` | `cancelled` | `POST .../cancel` | Reason required |
| `blocked` | `inProgress` | `POST .../resume` (unblock) | — |
| `blocked` | `cancelled` | `POST .../cancel` | Reason required |
| `completed` | — | Terminal | — |
| `cancelled` | — | Terminal | — |

### Completion guards

- Workflow status must be `inProgress` (not `waiting`/`blocked`/`notStarted`).
- All **applicable mandatory** steps must be `completed`, or `skipped`/`deferred` **only if** definition allows that disposition for the step.
- Optional steps may remain non-terminal.
- Conditional steps: if condition false → treated as not applicable (do not block); if true → treat per their requirement flag.
- Publish `WorkflowCompleted.v1` after durable commit.

### Cancellation

- Allowed from any non-terminal workflow status.
- Cascades: non-terminal steps → `cancelled` (system) with audit.
- Publish `WorkflowCancelled.v1` after durable commit.
- Terminal workflows reject further mutating commands (`409`).

### Derived status (optional helper)

UI may show aggregate progress (e.g. 8/12 steps complete). **Persisted** workflow status changes only via transitions above (not auto-derived from steps except where product policy auto-starts).

**Phase 1 policy:** Creating an instance leaves workflow at `notStarted` unless `autoStart=true` on create/event (then `inProgress` + emit `WorkflowStarted`).

---

## 2. Step state machine

### Transitions

| From | To | Trigger | Guards |
|------|----|---------|--------|
| `notStarted` | `inProgress` | step start | Workflow not terminal |
| `notStarted` | `skipped` | skip | Definition allows skip; reason required |
| `notStarted` | `cancelled` | cancel step / workflow cancel | Reason if user-initiated |
| `inProgress` | `waiting` | wait | Reason required |
| `inProgress` | `blocked` | block | Reason required |
| `inProgress` | `deferred` | defer | Definition allows defer; reason required |
| `inProgress` | `completed` | complete step | Step rules pass |
| `inProgress` | `skipped` | skip | Definition allows skip; reason required |
| `inProgress` | `cancelled` | cancel | Reason required |
| `waiting` | `inProgress` | resume | — |
| `waiting` | `cancelled` | cancel | Reason required |
| `blocked` | `inProgress` | resume (unblock) | — |
| `blocked` | `cancelled` | cancel | Reason required |
| `deferred` | `inProgress` | resume | — |
| `deferred` | `cancelled` | cancel | Reason required |
| `completed` | — | Terminal | — |
| `skipped` | — | Terminal | — |
| `cancelled` | — | Terminal | — |

### Rules

- `skipped` and `completed` and `cancelled` are **terminal** (no return to `inProgress`).
- `deferred` is **not** terminal; resume → `inProgress`.
- Mandatory steps cannot be skipped unless definition `allowSkipOnMandatory=true` (default **false**).
- Parent workflow terminal ⇒ reject step mutations (`409`).
- **Checklist cascade (Phase 1):** checklist intent APIs may automatically advance the parent step using the **same** step state machine and checklist readiness guards as explicit step start/complete — without changing transition tables. Typical: first checklist `start` ⇒ step `notStarted`→`inProgress`; when all blocking checklists are satisfied (`completed`, or allowed `skipped`/`deferred`) ⇒ step `inProgress`→`completed`. Explicit `POST .../steps/{stepId}/start|complete` remain valid.

---

## 3. Definition lifecycle

| From | To | Trigger |
|------|----|---------|
| (new) | `draft` | create / clone |
| `draft` | `draft` | update |
| `draft` | `published` | publish (sets PUBLISHED pointer) |
| `published` | `inactive` | inactivate |
| `inactive` | `draft` | clone to new version only (do not reactivate in place) |

Publishing a new version: create/update draft version → publish → update `PUBLISHED` pointer to that version. Prior published versions become historical (status may remain `published` for audit or flip to `inactive` — **Phase 1:** prior version set to `inactive` when a newer version is published).

---

## 4. Traceability matrix

| Transition family | API | Event | DB write |
|-------------------|-----|-------|----------|
| Create instance | Event + `POST /workflows` | `WorkflowStarted` via outbox | Instance + steps (≤80) + uniqueness + idempotency + audit + outbox |
| Workflow wait/block/resume/start/cancel/complete | Intent APIs + `If-Match` | Completed/Cancelled/Started via outbox | METADATA + GSI attrs + audit (+ cancel step cascade in **one** txn) |
| Step transitions | Step action API + step `If-Match` | — (Phase 1) | Step item + audit |
| Notes / evidence | Note/Evidence APIs | — | Note/Evidence + audit |
| Assign | Assign API + `If-Match` | — (Future: Assigned event) | METADATA GSI3 + audit |
