# DynamoDB Design — Workflow Runtime (Single Table)

**Table name:** `workflow-runtime` (env-specific prefix OK)  
**Billing:** On-demand (Phase 1); revisit provisioned if needed  
**Streams:** **Enabled (Phase 1)** — used by the transactional outbox relay (see §11). No new GSIs.

---

## 1. Design decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Model | Single table | One service bounded context; colocated instance graph |
| PK prefixes | `ORG#`, `WORKFLOW#`, `WORKFLOW_DEF#`, … | Platform convention |
| Attr names / enums | camelCase | Platform wire format |
| Uniqueness | Lock item + conditional Put | FR-008 |
| Idempotency | Items + TTL 7d | SQS / HTTP at-least-once |
| Latest published def | `SK=PUBLISHED` pointer | FR-003 |
| Overdue | Query by `dueAt`, not a status | C14 |
| GSI SK | `status#dueAt#workflowId` | Drop undefined `priority` from key |
| Assignee GSI | `ASSIGNEE#<type>#<id>` | user/role/team |
| OCC | `recordVersion` numeric + API `If-Match` | Concurrent staff edits |
| Multi-item writes | `TransactWriteItems` (single txn only) | Create / complete / cancel atomicity |
| Max steps (Phase 1) | **80** hard limit | Guarantee create/cancel fit one TransactWrite |
| Outbound events | Transactional outbox + Streams relay | No dual-write loss after commit |
| Audit | Append-only items | Immutable history |
| Idempotency TTL | Yes | Cost control |
| Audit TTL | No (Phase 1) | Retention via archive job (NFR) |

---

## 2. Base table keys

### 2.1 Entities

| Entity | PK | SK | entityType |
|--------|----|----|------------|
| Definition pointer (published) | `ORG#<orgId>#WORKFLOW_DEF#<workflowType>` | `PUBLISHED` | `WorkflowDefinitionPointer` |
| Definition version | `ORG#<orgId>#WORKFLOW_DEF#<workflowType>` | `VERSION#<version>` | `WorkflowDefinition` |
| Definition step | `ORG#<orgId>#WORKFLOW_DEF#<workflowType>` | `VERSION#<version>#STEP#<stepId>` | `WorkflowDefinitionStep` |
| Instance metadata | `ORG#<orgId>#WORKFLOW#<workflowId>` | `METADATA` | `WorkflowInstance` |
| Runtime step | `ORG#<orgId>#WORKFLOW#<workflowId>` | `STEP#<stepId>` | `WorkflowStep` (optional `instructions` copied from the published template at create) |
| Workflow note | `ORG#<orgId>#WORKFLOW#<workflowId>` | `NOTE#WORKFLOW#<ulid>` | `WorkflowNote` |
| Step note | `ORG#<orgId>#WORKFLOW#<workflowId>` | `NOTE#STEP#<stepId>#<ulid>` | `WorkflowNote` |
| Evidence | `ORG#<orgId>#WORKFLOW#<workflowId>` | `EVIDENCE#<stepId>#<ulid>` | `WorkflowEvidence` |
| Audit | `ORG#<orgId>#WORKFLOW#<workflowId>` | `AUDIT#<ulid>` | `WorkflowAudit` |
| Outbox event | `ORG#<orgId>#WORKFLOW#<workflowId>` | `OUTBOX#<ulid>` | `OutboxEvent` |
| Uniqueness lock | `ORG#<orgId>#WFUNIQUE#<workflowType>#<patientId>#<carePlanId>#<contextKey>` | `ACTIVE` | `WorkflowUniqueness` |
| Idempotency | `ORG#<orgId>#IDEMPOTENCY#<scope>#<key>` | `META` | `IdempotencyRecord` |

`version` is zero-padded string sortable, e.g. `0000000003`.  
`ulid` preferred over raw timestamps for uniqueness.

### 2.3a Workflow template catalog metadata

Optional attributes on the template `METADATA` item (`SK = METADATA`).
Values are Metadata Registry `metadataValueCode` strings. Omitted on records
created before these fields existed (no migration). Not copied onto patient
runtime step/checklist snapshots.

| Attribute | Metadata type | Example |
|-----------|---------------|---------|
| `category` | `Category` | `CHRONIC` |
| `shareScope` | `SelectScope` | `ORGANIZATION` |
| `language` | `Language` | `ENGLISH` |
| `country` | `Country` | `IN` |

### 2.3 Phase 1 maximum step count

| Constant | Value | Enforcement |
|----------|-------|-------------|
| `MAX_WORKFLOW_STEPS` | **80** | Reject definition create/update/publish and instance create if step count > 80 (`422`) |

**TransactWrite budget (must remain ≤ 100 items):**

| Operation | Items | Formula |
|-----------|-------|---------|
| Create (worst case) | uniqueness + METADATA + N steps + audit + idempotency + outbox (`WorkflowStarted` when `autoStart`) | **N + 5** |
| Cancel (worst case) | METADATA + N step updates + audit + uniqueness delete + outbox (`WorkflowCancelled`) | **N + 4** |
| Complete | METADATA + audit + uniqueness delete + outbox (`WorkflowCompleted`) (+ optional idempotency) | ≤ 5 |

With **N ≤ 80**: create ≤ 85, cancel ≤ 84 — both fit a **single** `TransactWriteItems`.  
**Chunked / multi-transaction cancel is forbidden.** Create stays a single
transaction too; only checklist items — which are unbounded and unreachable
until the instance exists — are pre-written in chunks when they would overflow
the budget (see § 7).

### 2.2 Core attributes (instance METADATA)

```
organizationId, workflowId, workflowType, definitionVersion,
patientId, carePlanId, contextKey,
workflowStatus, dueAt, priority (optional number),
assigneeType, assigneeId,
completionSummary (on complete), outcome,
correlationId, createdAt, updatedAt, createdBy, updatedBy,
recordVersion, entityType,
# GSI projections:
gsi1pk, gsi1sk, gsi2pk, gsi2sk, gsi3pk, gsi3sk, gsi4pk, gsi4sk, gsi5pk, gsi5sk, gsi6pk, gsi6sk
```

Terminal instances **clear** GSI3/GSI4 queue keys (sparse) so queues stay active-only. GSI1/GSI2/GSI5 retain history lists.

---

## 3. Global Secondary Indexes

| GSI | PK | SK | Purpose |
|-----|----|----|---------|
| **GSI1** | `ORG#<orgId>#PATIENT#<patientId>` | `createdAt#<workflowId>` | Patient timeline |
| **GSI2** | `ORG#<orgId>#CAREPLAN#<carePlanId>` | `createdAt#<workflowId>` | Care plan workflows |
| **GSI3** | `ORG#<orgId>#ASSIGNEE#<assigneeType>#<assigneeId>` | `<workflowStatus>#<dueAt>#<workflowId>` | My / team queue |
| **GSI4** | `ORG#<orgId>#STATUS#<workflowStatus>` | `<dueAt>#<workflowId>` | Dashboard by status; overdue = `dueAt < now` |
| **GSI5** | `ORG#<orgId>#TYPE#<workflowType>` | `<workflowStatus>#<createdAt>#<workflowId>` | By type (+ status prefix) |
| **GSI6** | `PLATFORM#WORKFLOW_TEMPLATE` or `ORG#<orgId>#WORKFLOW_TEMPLATE` (`gsi6pk`) | `<workflowStage>#<status>#<templateId>` (`gsi6sk`) | Platform / org workflow template catalog list |

### Indexes removed vs prior draft

| Removed | Why |
|---------|-----|
| Single `ORG#<orgId>` PK for all statuses | Hot partition; replaced by status-sharded GSI4 |
| `priority` in SK | Undefined in requirements; keep as filter attribute only |
| `OVERDUE` as status segment | Not a status — use dueAt range |

### Definition list access

Admin list by type: Query base PK `ORG#…#WORKFLOW_DEF#<type>` with `begins_with(VERSION#)` + FilterExpression on `definitionStatus`.  
Org-wide list across types (Phase 1): parallel queries for the three Phase 1 types (acceptable). Template catalog list uses **GSI6**.

---

## 4. Access pattern catalog

| # | Access pattern | How |
|---|----------------|-----|
| A1 | Get workflow by id | Get PK/SK=METADATA |
| A2 | Workflow + steps | Query PK begins_with STEP# |
| A3 | History | Query PK begins_with AUDIT# (paginate) |
| A4 | Notes | begins_with NOTE# |
| A5 | Evidence | begins_with EVIDENCE# |
| A6 | Patient workflows | GSI1 |
| A7 | Care plan workflows | GSI2 |
| A8 | Assignee queue | GSI3; optional begins_with status |
| A9 | Dashboard by status | GSI4 |
| A10 | Overdue | GSI4 per active status with `SK < now` (dueAt) — or FilterExpression if mixed |
| A11 | By type | GSI5 |
| A12 | Waiting / blocked queues | GSI4 PK status=`waiting`\|`blocked` |
| A13 | Reassignment | Update METADATA + GSI3 keys + audit (Transact) |
| A14 | Get published definition | Get SK=PUBLISHED → version; then VERSION# + STEP# |
| A15 | Get definition version | Get VERSION# |
| A16 | Definition steps | begins_with VERSION#v#STEP# |
| A17 | Create instance | Single Transact: uniqueness + METADATA + STEPs (≤80) + audit + idempotency + outbox (if Started); set GSIs |
| A18 | Complete / cancel | Single Transact: status, clear queue GSIs, audit, cascade **all** steps on cancel (≤80), uniqueness delete, outbox |
| A19 | Idempotent replay | Get idempotency item; short-circuit |
| A20 | Completion readiness | Read METADATA + STEPs + definition rules (app eval) |
| A21 | Outbox relay | Streams on `OutboxEvent` INSERT → EventBridge; mark/delete outbox item |
| A22 | List workflow templates | GSI6 Query `gsi6pk`; optional `begins_with(gsi6sk, <stage>#<status>#)` |

### Overdue query detail

For statuses `inProgress`, `waiting`, `blocked`, `notStarted`:

```
Query GSI4 PK = ORG#org#STATUS#inProgress
  SK between 0000-01-01 and <now>
```

Union results (app-side) for “Overdue” queue. Acceptable Phase 1 cardinality.

---

## 5. Uniqueness lock

```
PK: ORG#<orgId>#WFUNIQUE#<workflowType>#<patientId>#<carePlanId>#<contextKey>
SK: ACTIVE
Attrs: workflowId, createdAt
Condition on create: attribute_not_exists(pk)
On terminal complete/cancel: Delete lock item in same TransactWrite
```

---

## 6. Idempotency

```
PK: ORG#<orgId>#IDEMPOTENCY#<scope>#<key>
SK: META
Attrs: responseRef | workflowId, status, createdAt, ttl
ttl: epoch = now + 7 days
```

Scopes:
- `event` — key = `eventId`
- `http` — key = `Idempotency-Key` header (+ route)

---

## 7. Transactions & OCC

| Operation | Pattern |
|-----------|---------|
| Create from event/API | **One** TransactWrite: uniqueness + instance + N≤80 steps + audit + idempotency + outbox (if autoStart) |
| Step update | Update step `ConditionExpression recordVersion = :expected` then `recordVersion = :expected + 1`; Put audit |
| Assign | Update METADATA (GSI3) with OCC on `recordVersion`; Put audit |
| Complete | OCC METADATA; evaluator in app; update status; clear GSI3/4; Put audit; delete uniqueness; **Put outbox** |
| Cancel | **One** TransactWrite: OCC METADATA + update **all** N≤80 steps to `cancelled` + audit + delete uniqueness + **Put outbox** |

### OCC attribute rules

- `recordVersion` starts at `1` on create.
- Every successful mutation increments by 1.
- Condition: `recordVersion = :expected` (from client `If-Match` / body). Failure → API `409` (`VERSION_CONFLICT`).
- API contract: [`../05-api/rest-api.md`](../05-api/rest-api.md) § Optimistic concurrency.

DynamoDB transaction limit **100** items. With `MAX_WORKFLOW_STEPS = 80`, create/cancel **always** fit one transaction. No multi-txn cascade.

**Checklist items are not capped.** A template aggregate (`METADATA` + steps +
checklist items) or a runtime create can exceed 100 items, so the repositories
chunk the write instead of rejecting it:

- **Template create** — children are written first in chunks, then `METADATA`
  with `attribute_not_exists(sk)` as the commit point. The template is not
  readable until `METADATA` lands, so an interrupted write leaves nothing
  visible. Child puts are unconditional, so a retry is not self-blocking.
- **Template update (draft only)** — the conditional `METADATA` put runs first
  and is the OCC commit point, so a concurrent update still fails with
  `VERSION_CONFLICT`. Children and stale deletes follow in chunks. Only drafts
  are updatable and only **published** templates are snapshotted into patient
  workflows, so a partially rewritten draft can never reach a patient.
- **Publish** — a single-item `METADATA` flip; still fully atomic, and it only
  runs once children are complete.
- **Runtime create** — checklist items are pre-written in chunks, then the
  uniqueness / instance / steps / outbox transaction commits atomically.

Chunk size is a persistence detail (`DYNAMODB_TRANSACT_MAX_ITEMS`) and is never
surfaced as a product limit.

---

## 8. Attribute sizing / evidence

Evidence stores: `refType`, `refId`, `label?`, `stepId`, `addedBy`, `addedAt` — **no** domain payload blobs.

---

## 9. Hot partition & scale notes

- GSI4 sharded by status reduces single-org hot key vs prior design.
- Very large orgs: consider `ORG#orgId#STATUS#status#shard` later.
- Audit growth: archive to S3 after retention window (NFR); no TTL on audit Phase 1.

---

## 10. API / event coverage checklist

| Consumer | Supported by |
|----------|--------------|
| All REST gets/lists in `05-api` | A1–A16, A20; filter matrix in `05-api/filter-index-matrix.md` |
| CarePlanWorkflowRequested create | A17, A19 |
| WorkflowStarted/Completed/Cancelled | A17/A18 outbox → A21 Streams relay |
| Dashboard overdue / blocked / waiting | A9, A10, A12 |
| Assignment queues | A8, A13 |
| Definition publish | Pointer + version items |

---

## 11. Transactional outbox (reliable egress)

**Problem avoided:** dual-write (DynamoDB commit then best-effort `PutEvents`) can leave Care Plan without `WorkflowCompleted` / `WorkflowCancelled` / `WorkflowStarted`.

**Pattern (Phase 1):**

1. Business TransactWrite **includes** an `OutboxEvent` item in the same transaction as state change.
2. DynamoDB Stream (NEW_AND_OLD_IMAGES or NEW_IMAGE) triggers an **outbox relay** Lambda.
3. Relay filters `entityType = OutboxEvent` and `event.eventName = INSERT` (or `outboxStatus = pending`).
4. Relay calls EventBridge `PutEvents` with the stored payload.
5. On success, relay deletes the outbox item **or** updates `outboxStatus = published` (idempotent on stream retries via condition / ignore ConditionalCheckFailed).

### Outbox item attributes

```
entityType: OutboxEvent
outboxStatus: pending | published
detailType: WorkflowStarted.v1 | WorkflowCompleted.v1 | WorkflowCancelled.v1
eventId: <ulid>          # stable; also used as EventBridge event id / dedupe key
correlationId, organizationId, workflowId
payload: { ... }         # full event body per event-catalog.md
createdAt
```

### Keys

| PK | SK |
|----|----|
| `ORG#<orgId>#WORKFLOW#<workflowId>` | `OUTBOX#<ulid>` |

No additional GSI. Relay is stream-driven, not query-driven.

### Failure / recovery

| Failure | Behavior |
|---------|----------|
| Stream relay PutEvents fails | Lambda error → stream retry; item remains `pending` |
| PutEvents succeeds, delete fails | Stream redrive; PutEvents must be idempotent for consumers via `eventId` |
| Poison outbox | After max stream retries → DLQ on stream/Lambda; runbook republish |

**Do not** call EventBridge synchronously from the request path for Phase 1 domain egress. HTTP/API returns after durable TransactWrite (including outbox) succeeds.
