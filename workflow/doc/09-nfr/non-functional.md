# Non-Functional Requirements & Operations

## Performance

| Metric | Target (Phase 1) |
|--------|------------------|
| `GET` workflow / workbench / readiness p95 | ≤ 300 ms (warm) |
| Step action / assign p95 | ≤ 500 ms |
| Create workflow (transact) p95 | ≤ 1 s |
| Dashboard summary p95 | ≤ 500 ms |
| Event create end-to-end p95 | ≤ 3 s after enqueue |

## Scalability

- On-demand DynamoDB; GSI4 status-sharded
- SQS buffers Care Plan bursts
- Horizontal Lambda concurrency; reserved concurrency optional for consumer
- **Hard cap:** `MAX_WORKFLOW_STEPS = 80` (single TransactWrite for create/cancel including outbox)

## Concurrency

- OCC via `recordVersion` on METADATA, STEP, and definition version items
- API exposes `ETag` / requires `If-Match` (or body `recordVersion`) on mutations — see `05-api/rest-api.md`
- Uniqueness lock prevents duplicate active instances
- Idempotency keys for events and critical HTTP commands

## Monitoring & alarms

| Signal | Alarm |
|--------|-------|
| API 5xx rate | > 1% over 5 min |
| API p95 latency | Breach targets 10 min |
| SQS DLQ depth | > 0 for 5 min |
| Outbox relay / stream Lambda errors | > threshold |
| Outbox stream DLQ depth | > 0 for 5 min |
| Lambda errors | > threshold |
| DynamoDB throttles | > 0 sustained |

## Logging

- Structured JSON logs with `correlationId`, `workflowId`, `organizationId`, `eventId`
- No note bodies / PHI free text at info/debug in prod
- Log transition denials with error code

## Metrics (CloudWatch / EMF)

- `WorkflowCreated`, `WorkflowCompleted`, `WorkflowCancelled`
- `InvalidTransition`, `DuplicateActiveRejected`, `CompletionRejected`
- `EventProcessed`, `EventDuplicateIgnored`, `EventFailed`

## Tracing

- Propagate `correlationId` from inbound event / API gateway
- X-Ray or platform tracing on Lambda + downstream AWS SDK

## Retry policy

| Path | Policy |
|------|--------|
| SQS consumer | 5 receives → DLQ |
| Outbox → EventBridge | Streams relay retries; consumer-side dedupe on `eventId`; stream/Lambda DLQ + republish runbook |
| DynamoDB | SDK standard retry |

## Timeouts

| Component | Timeout |
|-----------|---------|
| API Lambda | 15 s |
| SQS consumer Lambda | 30 s |
| Downstream (none in Phase 1) | — |

## Retention

| Data | Retention |
|------|-----------|
| Idempotency items | 7 days (TTL) |
| Audit / instances | 2555 days (7 years) clinical default — confirm with compliance; archive to S3 after 365 days hot |
| SQS / DLQ messages | 14 days |

## Disaster recovery

| Item | Policy |
|------|--------|
| RPO | DynamoDB PITR enabled; RPO ≤ 5 min |
| RTO | Redeploy service stack ≤ 1 hour |
| Cross-region | Follow platform DR; not unique to Workflow Phase 1 |

## Operational runbooks (required before prod)

1. **DLQ replay** — inspect, fix, redrive to main queue  
2. **Stuck uniqueness lock** — when instance terminal but lock remains  
3. **Outbox / missed outbound event** — find `OUTBOX#` pending or stream DLQ; redrive relay; consumers dedupe on `eventId`  
4. **OCC conflict storm** — identify chatty clients; advise re-GET + retry with new `recordVersion`  
5. **Publish wrong definition** — inactivate; publish corrected version; document instance pinning  
6. **Unsupported filter 400s** — confirm client uses filter-index-matrix combinations only  

## Environment configuration

Document in service env: table name, bus name, queue URLs, stream ARN / relay function, JWT audience, log level — no secrets in repo.
