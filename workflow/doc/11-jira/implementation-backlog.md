# Implementation Roadmap — Jira Backlog (Phase 1)

**Source of truth:**  
`00-reconciliation/DECISIONS.md` · `04-persistence/db-design.md` · `05-api/rest-api.md` · `05-api/filter-index-matrix.md`

**Principles**
- Tickets are reviewable PRs; some are **sequentially coupled** (called out below) — not all are independently shippable to production.
- No Scan. Filter matrix is law for list/queue APIs.
- Outbound events only via **transactional outbox** (no sync PutEvents on request path).
- `GET /dashboard/summary` (E1) is **deferred** unless counters are implemented in a follow-up.

**Story points:** 1 · 2 · 3 · 5 · 8 · 13  

---

## Suggested order

| Order | Ticket | Why |
|------:|--------|-----|
| 1 | WR-01 | Persistence foundation |
| 2 | WR-01b | Care Plan ingress plumbing |
| 3 | WR-02 | Definitions before instances |
| 4 | WR-03 | Runtime write model |
| 5 | WR-04 | Queries + filter matrix |
| 6 | WR-05 + WR-06 | Commands with OCC **and** uniqueness/idempotency (same milestone) |
| 7 | WR-07 | Outbox relay (after commands write outbox items) |
| 8 | WR-10 | Auth before exposing HTTP |
| 9 | WR-08a → WR-08b → WR-08c | REST surface |
| 10 | WR-09 | Event consumer (can start after WR-05/06 create path) |
| 11 | WR-11 | Hardening, e2e, deferred E1 decision |

---

## WR-01 — DynamoDB infrastructure

**Title:** Create Workflow Runtime DynamoDB table (GSI1–5, Streams, TTL, PITR)

**Description**  
Provision the single-table design for Workflow Runtime.

**Scope**
- Table `workflow-runtime` (env-prefixed)
- On-demand billing
- DynamoDB Streams enabled (NEW_IMAGE or NEW_AND_OLD_IMAGES)
- GSI1 Patient · GSI2 Care Plan · GSI3 Assignee · GSI4 Status · GSI5 Type (keys per db-design.md)
- TTL attribute for idempotency items
- PITR if platform standard
- Encryption at rest
- Serverless/CFN resources + stack outputs (table name, stream ARN)

**Acceptance Criteria**
- [ ] Table + all five GSIs deploy via pipeline
- [ ] Streams enabled; stream ARN exported
- [ ] TTL attribute configured
- [ ] Smoke Put/Get in non-prod succeeds

**Dependencies:** None  
**Points:** 5  
**Coupling:** None

---

## WR-01b — Event ingress infrastructure

**Title:** EventBridge → SQS + DLQ for CarePlanWorkflowRequested

**Description**  
Wire Care Plan → Workflow async ingress (D03/D04).

**Scope**
- EventBridge rule on `CarePlanWorkflowRequested.v1`
- Standard SQS queue + DLQ (`maxReceiveCount=5`)
- Queue policy / IAM for EB → SQS
- CloudWatch alarm on DLQ depth
- Env/SSM for queue URL

**Acceptance Criteria**
- [ ] Test event lands on main queue
- [ ] After 5 failures message is on DLQ
- [ ] Alarm fires when DLQ visible > 0

**Dependencies:** Platform event bus  
**Points:** 3  
**Coupling:** Required before WR-09

---

## WR-02 — Workflow definition repository

**Title:** Persist workflow definitions (draft / publish / versions / steps)

**Description**  
Repository for admin definition lifecycle.

**Scope**
- Create draft, update draft, publish, inactivate, clone
- `PUBLISHED` pointer item
- Version items + definition steps under same PK
- **Draft update strategy that stays within DynamoDB 100-item Transact limit** (recommended: copy-on-write new draft version; do not delete+rewrite 80 steps in one naive 2N transaction)
- Conditional write on publish pointer (avoid lost publish)
- Enforce `MAX_WORKFLOW_STEPS = 80`

**Acceptance Criteria**
- [ ] Draft stored; only draft updatable
- [ ] Publish sets pointer and inactivates prior published version
- [ ] Get by version and get published work
- [ ] Steps queryable under definition PK
- [ ] >80 steps rejected
- [ ] 80-step draft update does not exceed chosen txn strategy

**Dependencies:** WR-01  
**Points:** 8  
**Coupling:** None (library/repo only)

---

## WR-03 — Workflow runtime write persistence

**Title:** Persist workflow instances, steps, notes, evidence, audit, outbox skeleton

**Description**  
Write-side persistence for runtime entities and key builders (not full list APIs).

**Scope**
- METADATA + STEP# items (N ≤ 80)
- Notes, evidence, audit append
- Outbox item shape (`OUTBOX#<ulid>`) — write helpers; relay is WR-07
- Uniqueness lock item helpers
- Idempotency item helpers (TTL)
- GSI attribute population on METADATA
- Clear GSI3/GSI4 attrs on terminal (helper)
- **dueAt required or documented sentinel** for GSI SK safety

**Acceptance Criteria**
- [ ] Create aggregate TransactWrite helper exists (wired fully in WR-05/06)
- [ ] Get by workflowId returns METADATA (+ optional step query)
- [ ] Notes / evidence / audit queries by begins_with work
- [ ] dueAt rule enforced in builders
- [ ] Keys match db-design.md

**Dependencies:** WR-01, WR-02 (for definition version pin on create)  
**Points:** 8  
**Coupling:** Completes with WR-05/06

---

## WR-04 — Query layer + filter matrix

**Title:** Implement repository queries per filter-index-matrix (no Scan)

**Description**  
All list/queue/history access patterns used by REST.

**Scope**
- A1 Get by id · A2 steps · A3 history · A4 notes · A5 evidence
- GSI1 patient · GSI2 care plan · GSI3 assignee · GSI4 status/overdue · GSI5 type
- Dashboard queues: `my`, `blocked`, `waiting`, `overdue` (multi-status merge), type queues
- Filter router: unsupported/ambiguous → error code for API layer
- **Exclude** `GET /dashboard/summary` aggregation (see WR-11)

**Acceptance Criteria**
- [ ] Every matrix row has a Query/GetItem implementation
- [ ] No Scan in repository code paths
- [ ] Unsupported combination raises domain/validation error (mapped to 400 later)
- [ ] Overdue single-status (W6) and queue=overdue documented/tested
- [ ] Cursor pagination works for single-partition queries

**Dependencies:** WR-03  
**Points:** 8  
**Coupling:** None for deploy of lib; HTTP in WR-08c

---

## WR-05 — Workflow commands + OCC + state machine

**Title:** Transactional workflow/step commands with recordVersion / If-Match

**Description**  
Domain command use cases and transitions (engine core).

**Scope**
- Assign, start, wait, block, resume, complete, cancel
- Step actions (start/complete/wait/block/resume/skip/defer/cancel) + step assign
- State transition engine + reason rules
- Completion evaluator (mandatory/optional/conditional; readiness DTO)
- `recordVersion` conditional updates; increment on success
- Single TransactWrite for create / complete / cancel (N ≤ 80; **no chunked cancel**)
- Write outbox item in same txn for Started / Completed / Cancelled
- Terminal immutability

**Acceptance Criteria**
- [ ] Illegal transitions → domain conflict/validation errors
- [ ] OCC mismatch fails condition
- [ ] Complete produces completionSummary
- [ ] Cancel cascades all steps in one transaction
- [ ] Outbox item present after start/complete/cancel success
- [ ] GSI3/GSI4 cleared on terminal

**Dependencies:** WR-02, WR-03, WR-04 (readiness may use reads), **WR-06 (same milestone)**  
**Points:** 13  
**Coupling:** **Must ship with WR-06** for create/complete/cancel

---

## WR-06 — Idempotency & active uniqueness

**Title:** HTTP/event idempotency + active workflow uniqueness lock

**Description**  
Protect duplicate creates and safe retries.

**Scope**
- Uniqueness lock Put with `attribute_not_exists`; delete on complete/cancel (same txn as WR-05)
- Idempotency records (event + HTTP scopes) + TTL
- **Lookup idempotency before OCC** on complete/cancel/start/create
- Store enough to **replay prior success response** (not only workflowId)
- Same key + different body → conflict
- Duplicate active instance → conflict

**Acceptance Criteria**
- [ ] Second create with same uniqueness key fails
- [ ] Lock removed on terminal
- [ ] Idempotent replay returns prior result without second outbox
- [ ] Body mismatch on reused key → conflict
- [ ] TTL set on idempotency items

**Dependencies:** WR-03  
**Points:** 5  
**Coupling:** **Merge/PR with WR-05** for create/complete/cancel paths

---

## WR-07 — Transactional outbox relay

**Title:** DynamoDB Streams outbox relay → EventBridge

**Description**  
Reliable egress for WorkflowStarted / Completed / Cancelled (D13).

**Scope**
- Streams-triggered Lambda
- Filter `entityType = OutboxEvent` (ESM filter preferred)
- PutEvents with catalog payloads
- Mark published or delete outbox; idempotent on redrive
- DLQ + alarm
- **No** EventBridge publish from API/SQS request handlers

**Acceptance Criteria**
- [ ] Complete/cancel/start durable success leaves outbox then event appears on bus
- [ ] Kill relay → item stays pending → recover publishes once (consumer dedupe on eventId)
- [ ] Failed PutEvents retries via stream/Lambda
- [ ] DLQ path tested

**Dependencies:** WR-01 (stream), WR-05 (writes outbox)  
**Points:** 8  
**Coupling:** Deploy after WR-05 writes outbox items

---

## WR-08a — REST: definition APIs

**Title:** Admin workflow definition HTTP APIs

**Description**  
Expose A1–A7 from rest-api.md.

**Scope**
- Create / update draft / publish / inactivate / get / list / clone
- Validation: max 80 steps; draft-only update
- OCC If-Match on update/publish/inactivate
- List requires `workflowType` (matrix §3)
- Authz hooks (permissions enforced fully with WR-10)

**Acceptance Criteria**
- [ ] Routes match `/v1/workflow-definitions…`
- [ ] Error envelope + 422 MAX_STEPS_EXCEEDED
- [ ] 428 without If-Match; 409 VERSION_CONFLICT
- [ ] Contract tests for happy paths

**Dependencies:** WR-02, WR-10  
**Points:** 5  
**Coupling:** Behind auth (WR-10)

---

## WR-08b — REST: runtime command APIs

**Title:** Runtime command HTTP APIs (create + intent + notes/evidence)

**Description**  
Expose B1, B4–B10, C1–C2, D1–D3.

**Scope**
- Create workflow; assign; start/wait/block/resume/complete/cancel
- Step actions + step assign
- Notes + evidence POST
- Idempotency-Key on create/complete/cancel (and as specified)
- If-Match / recordVersion; prefer **409** only for version conflict (not 412)
- Map domain errors to API codes

**Acceptance Criteria**
- [ ] No free-form status PATCH
- [ ] OCC + idempotency behavior matches rest-api.md
- [ ] Complete returns completionSummary; cancel requires reason
- [ ] Contract tests green

**Dependencies:** WR-05, WR-06, WR-07, WR-10  
**Points:** 8  
**Coupling:** Requires engine + outbox + auth

---

## WR-08c — REST: query, workbench, queues

**Title:** Query / workbench / queue / readiness HTTP APIs

**Description**  
Expose B2–B3, B11, D4, E2–E4. **Do not implement E1 summary counts** in this ticket.

**Scope**
- Get workflow (`include=`), list (filter matrix), history, notes/evidence list
- Dashboard queues (E2)
- Workbench (E3), completion-readiness (E4)
- Pagination cursors
- 400 UNSUPPORTED_FILTER / AMBIGUOUS_FILTER

**Acceptance Criteria**
- [ ] Filter matrix enforced; no Scan
- [ ] Workbench has no peer-domain payloads
- [ ] Readiness returns missingRequirements / blockingIssues
- [ ] E1 not implemented (501/omitted) unless WR-11 counters done

**Dependencies:** WR-04, WR-10  
**Points:** 5  
**Coupling:** Behind auth

---

## WR-09 — CarePlanWorkflowRequested consumer

**Title:** SQS consumer for CarePlanWorkflowRequested.v1

**Description**  
Primary creation path from Care Plan Runtime.

**Scope**
- SQS event source mapping
- Map camelCase payload → create use case
- Idempotency on `eventId`
- Partial batch failure reporting
- Reject >80 steps / missing published def
- dueAt from event or sentinel

**Acceptance Criteria**
- [ ] Happy path creates instance (+ outbox Started if autoStart)
- [ ] Duplicate eventId is no-op success
- [ ] Poison → DLQ after retries
- [ ] Enums camelCase end-to-end

**Dependencies:** WR-01b, WR-05, WR-06, WR-07  
**Points:** 8  
**Coupling:** Can develop in parallel with WR-08 once create path exists

---

## WR-10 — Authentication & authorization

**Title:** JWT authorizer, org isolation, RBAC

**Description**  
Secure all `/v1` routes (except health).

**Scope**
- Bearer JWT validation (platform IdP/Cognito)
- `organizationId` claim vs PK scoping
- Permission checks per rest-api.md catalog
- Cross-tenant access denied

**Acceptance Criteria**
- [ ] 401 without/invalid token
- [ ] Cross-org get → 403/404
- [ ] RBAC denies documented in tests
- [ ] Health remains reachable as designed

**Dependencies:** WR-01 (config)  
**Points:** 5  
**Coupling:** Block public expose of WR-08* until done

---

## WR-11 — Hardening, e2e, dashboard summary decision

**Title:** Validation hardening, e2e tests, E1 defer-or-counters

**Description**  
Close Phase 1 quality bar and resolve dashboard summary.

**Scope**
- Automated tests: transitions, uniqueness, idempotency replay, outbox, filter 400s, OCC
- Runbooks: DLQ, outbox republish, uniqueness lock, OCC storms
- Metrics/alarms smoke (API 5xx, SQS DLQ, outbox DLQ)
- **E1 decision (pick one):**
  - **Defer:** document + omit/501, **or**
  - **Counters:** org counter items in same Transact as status changes + implement `GET /dashboard/summary`

**Acceptance Criteria**
- [ ] Critical-path e2e green in CI
- [ ] Runbooks linked from service README
- [ ] E1 either deferred with explicit note or counters + summary shipped without Scan
- [ ] OpenAPI/README points to `doc/` SoT

**Dependencies:** WR-08*, WR-09, WR-07  
**Points:** 8 (5 if E1 deferred only)  
**Coupling:** End of Phase 1

---

## Traceability to design

| Design concern | Ticket(s) |
|----------------|-----------|
| Single-table + GSI1–5 | WR-01 |
| Ingress EB→SQS | WR-01b, WR-09 |
| Definitions + PUBLISHED | WR-02, WR-08a |
| Instance/steps/notes/evidence/audit | WR-03, WR-05 |
| Filter matrix / no Scan | WR-04, WR-08c |
| OCC / intent commands | WR-05, WR-08b |
| Uniqueness + idempotency | WR-06 |
| Outbox + EventBridge egress | WR-07 |
| REST | WR-08a/b/c |
| Care Plan consumer | WR-09 |
| JWT/RBAC | WR-10 |
| Max 80 steps / e2e / E1 | WR-02, WR-05, WR-11 |

---

## What we deliberately do **not** claim

- Every ticket independently production-deployable in isolation  
- Dashboard summary counts without counters (deferred to WR-11)  
- Chunked cancel  
- Sync EventBridge publish from request handlers  
- Peer-domain HTTP from Workflow (BFF owns aggregation)
