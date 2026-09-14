/**
 * Integration contract: Workflow complete → outbox → workflow-service bus → CPR queue → CPR consumer.
 *
 * Routing (P0 #1) + BaseEvent Detail (P0 #2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OUTBOX_DETAIL_TYPE,
  WorkflowRuntimeEntityBuilder,
  buildWorkflowCompletedBaseEvent,
  mapOutboxToPutEventsEntry,
} from '@api-hub/workflow-runtime-core';

// __dirname = apps/workflow-service/src/__tests__
const WF_ROOT = join(__dirname, '../..');
const CPR_ROOT = join(__dirname, '../../../care-plan-runtime');

function loadYaml(absPath: string): string {
  return readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
}

function extractResourceBlock(yaml: string, resourceName: string): string {
  const marker = `\n  ${resourceName}:\n`;
  const start = yaml.indexOf(marker);
  if (start < 0) {
    throw new Error(`Resource ${resourceName} not found`);
  }
  const rest = yaml.slice(start + 1);
  const next = rest.search(/\n  [A-Z][A-Za-z0-9]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('WorkflowCompleted.v1 → CPR routing integration', () => {
  const stage = 'dev';
  const workflowBus = `workflow-service-bus-${stage}`;
  const eventSource = 'workflow-service';

  const envelope = buildWorkflowCompletedBaseEvent({
    eventId: '01WFCOMPLETEDOUTBOX',
    timestamp: '2026-08-25T00:00:00.000Z',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    patientId: 'pat-1',
    carePlanId: 'cpi-1',
    workflowType: 'PATIENT_ONBOARDING',
    correlationId: 'corr-1',
    completedAt: '2026-08-25T00:00:00.000Z',
    completedBy: 'user-1',
    outcome: 'completed',
    completionSummary: {
      totalSteps: 1,
      completedSteps: 1,
      skippedSteps: 0,
      deferredSteps: 0,
    },
  });

  const outbox = WorkflowRuntimeEntityBuilder.buildOutboxEvent({
    organizationId: 'org-1',
    workflowId: 'wf-1',
    eventId: envelope.eventId,
    detailType: OUTBOX_DETAIL_TYPE.WORKFLOW_COMPLETED,
    createdAt: envelope.timestamp,
    correlationId: envelope.meta.correlationId,
    payload: envelope as unknown as Record<string, unknown>,
  });

  const putEntry = mapOutboxToPutEventsEntry(
    outbox,
    { eventBusName: workflowBus, eventSource },
    'stream-1',
  );

  it('1) workflow complete writes pending outbox with WorkflowCompleted.v1 BaseEvent', () => {
    expect(outbox.outboxStatus).toBe('pending');
    expect(outbox.detailType).toBe('WorkflowCompleted.v1');
    expect(outbox.payload?.eventType).toBe('WorkflowCompleted.v1');
    expect(
      (outbox.payload as { payload?: { carePlanId?: string } })?.payload
        ?.carePlanId,
    ).toBe('cpi-1');
  });

  it('2) outbox relay PutEvents targets workflow-service bus', () => {
    expect(putEntry.EventBusName).toBe(workflowBus);
    expect(putEntry.Source).toBe('workflow-service');
    expect(putEntry.DetailType).toBe('WorkflowCompleted.v1');
    expect(JSON.parse(putEntry.Detail).eventId).toBe(envelope.eventId);

    const runtime = loadYaml(join(WF_ROOT, 'config/runtime-dev.yml'));
    expect(runtime).toMatch(
      /WORKFLOW_EVENT_BUS_NAME:\s*workflow-service-bus-\$\{self:provider\.stage\}/,
    );
  });

  it('3) CPR rule on workflow-service bus matches PutEvents → Completed queue', () => {
    const rules = loadYaml(
      join(CPR_ROOT, 'infra/resources/events/event-rules.yml'),
    );
    const primary = extractResourceBlock(
      rules,
      'CarePlanRuntimeWorkflowCompletedRule',
    );

    expect(primary).toContain(
      'EventBusName: ${self:custom.bundle.workflowServiceEventBusName}',
    );
    expect(primary).toMatch(/source:\s*\n\s+- workflow-service/);
    expect(primary).toContain('WorkflowCompleted.v1');
    expect(primary).toContain('CarePlanRuntimeWorkflowCompletedQueue');

    const custom = loadYaml(join(CPR_ROOT, 'infra/config/infra-custom.yml'));
    expect(custom).toContain(
      'workflowServiceEventBusName: workflow-service-bus-${self:provider.stage}',
    );

    expect(['workflow-service']).toContain(putEntry.Source);
    expect(['WorkflowCompleted.v1', 'WorkflowCompleted']).toContain(
      putEntry.DetailType,
    );
  });

  it('4) CPR queue policy allows EventBridge from workflow-service bus', () => {
    const policies = loadYaml(
      join(CPR_ROOT, 'infra/resources/events/queue-policies.yml'),
    );
    expect(policies).toContain('AllowEventBridgeFromWorkflowServiceBus');
    expect(policies).toContain(
      'rule/${self:custom.bundle.workflowServiceEventBusName}/*',
    );
    expect(policies).toContain('CarePlanRuntimeWorkflowCompletedQueue');
  });

  it('5) CPR onWorkflowCompleted Lambda is subscribed to that queue', () => {
    const serverless = loadYaml(join(CPR_ROOT, 'serverless.yml'));
    const start = serverless.indexOf('onWorkflowCompleted:');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = serverless.slice(start);
    const next = rest.search(/\n  [a-zA-Z][a-zA-Z0-9]*:\n/);
    const block = next < 0 ? rest : rest.slice(0, next);
    expect(block).toContain('CarePlanRuntimeWorkflowCompletedQueue');
    expect(block).toContain('sqs:');
  });

  it('6) EventBridge→SQS Detail is BaseEvent with CPR payload fields', () => {
    const detail = JSON.parse(putEntry.Detail) as Record<string, unknown>;
    expect(detail.eventType).toBe('WorkflowCompleted.v1');
    expect(detail.source).toBe('workflow-service');
    expect(detail.idempotencyKey).toBe(envelope.eventId);
    expect(detail.payload).toEqual(
      expect.objectContaining({
        eventId: envelope.eventId,
        organizationId: 'org-1',
        patientId: 'pat-1',
        carePlanId: 'cpi-1',
        workflowType: 'PATIENT_ONBOARDING',
        outcome: 'completed',
        workflowInstanceId: 'wf-1',
      }),
    );
  });
});
