# Architecture — Workflow Runtime Service (Phase 1)

## Overview

Reusable engine for configurable, step-based care-team workflows. Phase 1 executes Care Plan workflows: `PATIENT_ONBOARDING`, `FORMAL_REVIEW`, `CLOSURE_REVIEW`.

```
Admin UI ──REST──► API Gateway ──► API Lambda (POC: one Lambda for all HTTP routes)
                                      │
                                      ▼
                               DynamoDB (single table: workflow-service-{stage})
                                      ▲                        │
Care Plan Runtime ──EventBridge──► SQS ──► SQS Lambda ─────────┘
                                                               │ Streams
                                                               ▼
                                                     Stream Lambda (outbox relay)
                                                               │
                                                               ▼
                                                         EventBridge
                                                 WorkflowStarted |
                                                 WorkflowCompleted |
                                                 WorkflowCancelled
                                                              │
                                                              ▼
                                                      Care Plan Runtime

BFF/Workbench ──REST──► Workflow (workflow state)
             ──REST──► Peer domain services (context panels)
```

POC note: the application intentionally uses a **single API Lambda** as the API Gateway integration target. Existing handler modules remain the business implementation; a dispatcher in `src/handlers/http/api.ts` routes by HTTP method and resource/path. API paths, methods, authorizers, and CORS are unchanged.

## Components

### Workflow Management
Definitions · Instances · Steps · Assignment · Notes · Evidence references · Audit · Outbox

### Workflow Engine Core
| Component | Responsibility |
|-----------|----------------|
| Definition Resolver | Load published definition (+ version pin if requested); enforce max 80 steps |
| State Transition Engine | Validate workflow/step transitions |
| Conditional Rule Engine | Evaluate conditional step applicability |
| Assignment Resolver | Normalize user/role/team assignees |
| Idempotency Guard | Dedupe event and HTTP idempotent commands |
| Completion Evaluator | Mandatory/optional/conditional readiness |
| Outbox Relay | Streams → EventBridge for Started/Completed/Cancelled |

## Communication

| Path | Style | Use |
|------|-------|-----|
| Admin + staff commands/queries | Synchronous REST `/v1` | Definitions, steps, notes, evidence, assign, complete, cancel, queues |
| Care Plan → Workflow start | Async EventBridge → SQS | `CarePlanWorkflowRequested` |
| Workflow → Care Plan outcomes | Durable outbox + Streams → EventBridge | Started / Completed / Cancelled |
| Peer domain context | BFF → peer REST | Not Workflow |

## Design principles

1. Process ownership vs domain ownership (clear boundary)
2. Event-driven Care Plan integration with **transactional outbox**
3. REST for user interactions (OCC via `If-Match` / `recordVersion`)
4. Single-table DynamoDB (GSI1–GSI5 unchanged; outbox entity colocated)
5. Immutable audit append
6. camelCase wire enums
7. Extensible workflow types without engine rewrite
8. List APIs only via documented filter→index matrix (no Scan)

## Non-goals (Phase 1)

- Domain adapters inside Workflow
- Staff notification delivery or `WorkflowNotificationRequested`
- Using Task Runtime as step engine
- Generic BPMN / arbitrary graph workflows beyond ordered steps + conditions
- Adding/removing GSIs beyond the reconciled GSI1–GSI5 set