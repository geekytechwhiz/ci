# Event Catalog — Final (Phase 1 + Future)

**Bus:** Amazon EventBridge (platform bus or service bus per env)  
**Ingress:** EventBridge rule → SQS standard queue → Lambda consumer → DLQ  
**Egress:** Transactional outbox item in same DynamoDB TransactWrite → DynamoDB Streams relay Lambda → EventBridge `PutEvents`  
**Do not** publish domain egress events synchronously from the API/consumer request path.  
**detail-type:** `EventName.v1` (version suffix)  
**Payload enums/fields:** camelCase ([`../03-domain/status-enums.md`](../03-domain/status-enums.md))  
**Decisions:** D04, D12, D13 (outbox)

---

## Operational defaults (all events)

| Concern | Policy |
|---------|--------|
| Ordering | **No** cross-instance ordering guarantee (SQS standard). Per-instance commands are REST-serialized via OCC. |
| Retry (ingress) | SQS redrive: `maxReceiveCount=5`, exponential backoff via visibility timeout (start 30s) |
| DLQ | After max receives → DLQ; alarm on `ApproximateNumberOfMessagesVisible > 0` |
| Idempotency | Consumer must ignore duplicates using `eventId` (idempotency item, TTL 7d) |
| Producer idempotency | Outbox `eventId` is stable; EventBridge publishes use that id; consumers dedupe on `eventId` |
| Egress reliability | Outbox + Streams relay; stream/Lambda DLQ + republish runbook |
| Timeout | Consumer Lambda 30s Phase 1; batch size 5; outbox relay Lambda 30s |
| Envelope | See common envelope below |

### Common envelope fields (all Phase 1 events)

| Field | Required | Description |
|-------|----------|-------------|
| `eventId` | Yes | Globally unique id |
| `eventType` | Yes | Same as detail-type without needing bus metadata |
| `eventVersion` | Yes | `1` |
| `timestamp` | Yes | ISO-8601 |
| `organizationId` | Yes | Tenant |
| `correlationId` | Yes | Trace across Care Plan ↔ Workflow |
| `causationId` | No | Prior event id |

---

## A. Inbound (Phase 1)

### CarePlanWorkflowRequested.v1

| | |
|--|--|
| **Producer** | Care Plan Runtime |
| **Consumer** | Workflow Runtime (SQS) |
| **Trigger** | Care plan activated / review due / closure ready (Care Plan maps internally) |
| **Ordering** | None required vs other patients |
| **Retry / DLQ** | Platform defaults above |
| **Idempotency** | Dedupe on `eventId`; also uniqueness lock prevents duplicate active instance |

**Required payload**

| Field | Type |
|-------|------|
| `eventId` | string |
| `eventType` | `"CarePlanWorkflowRequested"` |
| `eventVersion` | `1` |
| `timestamp` | string |
| `organizationId` | string |
| `patientId` | string |
| `carePlanId` | string |
| `workflowType` | `PATIENT_ONBOARDING` \| `FORMAL_REVIEW` \| `CLOSURE_REVIEW` |
| `correlationId` | string |

**Optional payload**

| Field | Type | Notes |
|-------|------|-------|
| `contextKey` | string | Default `"default"` |
| `definitionVersion` | number | Pin version; else PUBLISHED |
| `requestedBy` | string | user or `system` |
| `assignee` | object | `{ assigneeType, assigneeId }` |
| `dueAt` | string | ISO-8601 |
| `autoStart` | boolean | Default `true` |
| `causationId` | string | |

**Processing:** Validate published def (≤80 steps) → Transact create (incl. outbox if autoStart) → Streams relay publishes `WorkflowStarted` when present.

---

## B. Outbound (Phase 1)

### WorkflowStarted.v1

| | |
|--|--|
| **Producer** | Workflow Runtime |
| **Consumers** | Care Plan Runtime (optional interest); analytics |
| **Trigger** | First transition to `inProgress` (create autoStart or `/start`) |
| **Idempotency** | Consumers dedupe `eventId`; producer emits once per start transition |

**Required:** `eventId`, `eventType`, `eventVersion`, `timestamp`, `organizationId`, `workflowId`, `patientId`, `carePlanId`, `workflowType`, `correlationId`, `startedAt`, `definitionVersion`  
**Optional:** `startedBy`, `contextKey`, `assignee`

---

### WorkflowCompleted.v1

| | |
|--|--|
| **Producer** | Workflow Runtime |
| **Consumers** | Care Plan Runtime (**required**) |
| **Trigger** | Successful `POST .../complete` after durable commit |
| **Idempotency** | Dedupe `eventId`; complete API idempotent |

**Required:**  
`eventId`, `eventType`, `eventVersion`, `timestamp`, `organizationId`, `workflowId`, `patientId`, `carePlanId`, `workflowType`, `correlationId`, `completedAt`, `completedBy`, `outcome`, `completionSummary`

`outcome` (lifecycle, camelCase): **`completed`** only from `POST .../complete`.  
(`cancelled` is produced by cancel path / `WorkflowCancelled.v1`, not by the complete API.)

`completionSummary` example:
```json
{
  "totalSteps": 12,
  "completedSteps": 10,
  "skippedSteps": 1,
  "deferredSteps": 1,
  "finalNote": "…"
}
```

**Optional:** `contextKey`, `definitionVersion`

---

### WorkflowCancelled.v1

| | |
|--|--|
| **Producer** | Workflow Runtime |
| **Consumers** | Care Plan Runtime (**required**) |
| **Trigger** | Successful cancel after durable commit |

**Required:** `eventId`, `eventType`, `eventVersion`, `timestamp`, `organizationId`, `workflowId`, `patientId`, `carePlanId`, `workflowType`, `correlationId`, `cancelledAt`, `cancelledBy`, `reason`  
**Optional:** `contextKey`

---

## C. Internal events

**Phase 1:** none. All internal work is synchronous within Lambda/API or transactional DynamoDB writes. No internal EventBridge domain events required.

---

## D. Future events (not implemented Phase 1)

Documented so client §6 is not lost. Do **not** build consumers/producers in Phase 1.

### Future inbound

| Event | Producer | Purpose |
|-------|----------|---------|
| `AppointmentCompleted` | Appointment | Refresh context |
| `LabReportUploaded` | Lab | Evidence hint |
| `AlertResolved` | Alert | Open-issue context |
| `MonitoringStatusUpdated` | Monitoring | Optional refresh |
| `WorkflowNotificationDelivered` | Notification | Audit delivery |

### Future outbound

| Event | Consumer | Purpose |
|-------|----------|---------|
| `WorkflowAssigned` | Notification / BFF | Assignment notify |
| `WorkflowStepCompleted` | Interested peers | Step awareness |
| `WorkflowBlocked` | Notification | Escalation |
| `WorkflowWaiting` | Notification | Dependency wait |
| `WorkflowNotificationRequested` | Notification/Scheduler | FR-029 |

---

## E. Mapping from client suggested names

| Client suggested | Phase 1 handling |
|------------------|------------------|
| `CarePlanActivated` / `CarePlanReviewDue` / `CarePlanClosureDue` | Care Plan emits `CarePlanWorkflowRequested` with appropriate `workflowType` |
| `WorkflowStarted` | Implemented |
| `WorkflowCompleted` / `WorkflowCancelled` | Implemented |
| All others | Future (section D) |
