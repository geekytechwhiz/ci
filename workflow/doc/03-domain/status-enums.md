# Status & Type Enums (Single SoT)

All API JSON, DynamoDB attributes, and event payloads use these **camelCase** values.

Const-object style in code (SCREAMING_SNAKE keys, camelCase values) per platform rules.

---

## WorkflowStatus

| Value | Meaning | Terminal? |
|-------|---------|-----------|
| `notStarted` | Instance created; execution not started | No |
| `inProgress` | Actively being worked | No |
| `waiting` | Waiting on dependency / external input | No |
| `blocked` | Cannot proceed until blocker resolved | No |
| `completed` | Completed successfully | Yes |
| `cancelled` | Stopped; will not continue | Yes |

**Active** = any non-terminal status (`notStarted`, `inProgress`, `waiting`, `blocked`).

---

## WorkflowLifecycleOutcome (complete / cancel → Care Plan)

Wire values on `WorkflowCompleted.v1.payload.outcome` and persisted instance `outcome`.

| Value | Meaning | Produced by |
|-------|---------|-------------|
| `completed` | Successful workflow completion | `POST .../complete` (required) |
| `cancelled` | Workflow cancelled | `POST .../cancel` (persisted + cancel event) |

Care Plan Runtime applies onboarding → `fullyActive` and formal-review occurrence completion **only** when `outcome = completed`. Free-form values (e.g. `approved`) are **not** allowed.

---

## StepStatus

| Value | Meaning | Terminal? |
|-------|---------|-----------|
| `notStarted` | Not started | No |
| `inProgress` | Being worked | No |
| `waiting` | Waiting on dependency | No |
| `blocked` | Blocked | No |
| `deferred` | Postponed; may resume | No |
| `completed` | Done successfully | Yes |
| `skipped` | Skipped with allowed reason | Yes |
| `cancelled` | No longer applies | Yes |

---

## DefinitionStatus

| Value | Meaning |
|-------|---------|
| `draft` | Editable; cannot start instances |
| `published` | Eligible for new instances |
| `inactive` | Not used for new instances; existing instances unaffected |

---

## WorkflowType (Phase 1)

| Value | Meaning |
|-------|---------|
| `PATIENT_ONBOARDING` | Steps before care plan fully active |
| `FORMAL_REVIEW` | Scheduled review process |
| `CLOSURE_REVIEW` | Final review before care plan completion |

---

## StepRequirement

| Value | Meaning |
|-------|---------|
| `mandatory` | Must be completed, or skipped/deferred only if definition allows |
| `optional` | Need not block workflow completion |
| `conditional` | Applies only when condition evaluates true |

---

## AssigneeType

| Value |
|-------|
| `user` |
| `role` |
| `team` |

---

## EvidenceRefType (extensible)

Examples: `labReport`, `alert`, `reading`, `appointment`, `document`, `task`, `note`, `device`, `other`

---

## Mapping from legacy doc names

| Legacy (client / SM) | Canonical |
|----------------------|-----------|
| NotStarted / CREATED / NOT_STARTED | `notStarted` |
| InProgress / IN_PROGRESS | `inProgress` |
| Waiting / WAITING | `waiting` |
| Blocked / BLOCKED | `blocked` |
| Completed / COMPLETED | `completed` |
| Cancelled / CANCELLED | `cancelled` |
| Skipped / SKIPPED | `skipped` |
| Deferred / DEFERRED | `deferred` |
| PatientOnboarding / PATIENT_ONBOARDING | `PATIENT_ONBOARDING` |
| FormalReview / FORMAL_REVIEW | `FORMAL_REVIEW` |
| ClosureReview / CLOSURE_REVIEW | `CLOSURE_REVIEW` |
| Draft / Published / Inactive | `draft` / `published` / `inactive` |
