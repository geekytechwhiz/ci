# Sequence Flows (Reconciled)

Aligned to API + events + DB. Legacy ASCII diagrams in `2. Sequence Diagram.docx` are superseded by these flows.

---

## 1. Workflow creation (event-driven)

```
Care Plan Runtime → EventBridge: CarePlanWorkflowRequested.v1
EventBridge → SQS
SQS → Workflow Runtime consumer
  → Idempotency check (eventId)
  → Load PUBLISHED definition (+ steps; reject if >80 steps)
  → TransactWrite (single txn):
       uniqueness lock
       METADATA (GSIs)
       STEP# items (N≤80)
       AUDIT
       IDEMPOTENCY
       OUTBOX# (WorkflowStarted if autoStart)
  → 200/ack to SQS
DynamoDB Stream → Outbox relay → EventBridge: WorkflowStarted.v1
```

**Manual variant:** `POST /v1/workflows` → same pipeline (HTTP idempotency key).

---

## 2. Complete step

```
UI → API GW → POST /workflows/{id}/steps/{stepId}/actions
     Headers: If-Match: W/"<step.recordVersion>"
Workflow Runtime:
  → Load step + workflow (OCC on step recordVersion)
  → Validate transition + rules
  → Update STEP + AUDIT
  → 200 step (new recordVersion)
```

No outbound domain event in Phase 1.

---

## 3. Complete workflow

```
UI → POST /workflows/{id}/complete
     If-Match: W/"<workflow.recordVersion>"
Workflow Runtime:
  → Load METADATA + STEPs + definition rules
  → Completion evaluator
  → if fail: 422 + missingRequirements
  → TransactWrite (single): status=completed, clear queue GSIs, delete uniqueness, AUDIT, OUTBOX WorkflowCompleted
  → 200 + completionSummary
DynamoDB Stream → Outbox relay → EventBridge → Care Plan Runtime
```

---

## 4. Cancel workflow

```
UI → POST /workflows/{id}/cancel { reason }
     If-Match: W/"<workflow.recordVersion>"
Workflow Runtime:
  → Validate non-terminal + OCC
  → TransactWrite (single, N≤80): workflow cancelled, all steps cancelled, clear GSIs, delete uniqueness, AUDIT, OUTBOX WorkflowCancelled
  → 200
DynamoDB Stream → Outbox relay → EventBridge → Care Plan Runtime
```

**No chunked cancel.**

---

## 5. Add note / evidence

```
UI → POST notes | evidence
→ Save NOTE#/EVIDENCE# + AUDIT
→ 201
```

---

## 6. Assignment

```
UI → POST /workflows/{id}/assign
→ Validate assignee
→ Update METADATA GSI3 + AUDIT
→ 200
```

No `WorkflowAssigned` event in Phase 1.

---

## 7. Completion readiness

```
UI → GET /workflows/{id}/completion-readiness
→ Check mandatory / waiting / blocked / conditional
→ { ready, missingRequirements, blockingIssues }
```
