# Ownership Model

## Workflow Runtime owns

- Workflow definitions (versioned) and definition steps
- Workflow instances and runtime steps
- Assignment state (workflow + step)
- Notes (workflow + step)
- Evidence **references** (IDs + type + optional label)
- Completion readiness evaluation
- Workflow-centric dashboard/queue/workbench **projections**
- Audit/history records for workflow actions
- Idempotency and uniqueness control records

## Workflow Runtime does not own

- Care plan lifecycle state (Care Plan Runtime)
- Tasks, alerts, readings, goals, symptoms, labs, appointments, documents, devices
- Notification delivery channels
- BFF aggregation of multi-domain workbench panels

## Care Plan Runtime owns

- When to request a workflow (`CarePlanWorkflowRequested`)
- Interpreting `WorkflowCompleted` / `WorkflowCancelled` / `WorkflowStarted` for care plan transitions

## BFF / Portal owns

- Composing workbench UI from Workflow APIs + peer domain APIs
- Presenting linked records from evidence references (open-by-id into peer UIs/APIs)

## Admin UI owns

- Authoring definitions (via Workflow Admin APIs)

## RACI (Phase 1)

| Concern | Workflow | Care Plan | BFF | Peer domain |
|---------|----------|-----------|-----|-------------|
| Start workflow | R (execute) | A (request) | C (manual UI may call start) | — |
| Step execution | A/R | I | C (UI) | — |
| Domain facts on workbench | — | — | A/R (aggregate) | R (serve data) |
| Completion outcome | A/R (publish) | A (consume) | I | — |
