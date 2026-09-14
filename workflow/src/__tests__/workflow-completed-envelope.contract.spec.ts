/**
 * Contract: WRS WorkflowCompleted BaseEvent Detail → CPR schema validation.
 *
 * P0 #2 — single production envelope (BaseEvent). Flat catalog Detail must fail.
 */
import {
  EventValidationError,
  validateBaseEvent,
} from '../../../../libs/event-platform/src/core/event-envelope/validate-base-event';
import {
  WorkflowRuntimeEntityBuilder,
  OUTBOX_DETAIL_TYPE,
  buildWorkflowCompletedBaseEvent,
  mapOutboxToPutEventsEntry,
  WORKFLOW_COMPLETED_EVENT_TYPE,
} from '@api-hub/workflow-runtime-core';

import {
  WorkflowCompletedPayloadSchema,
  normalizeWorkflowCompletedPayload,
} from '../../../care-plan-runtime/src/handlers/events/inbound/workflow-completed.event';

describe('WorkflowCompleted.v1 envelope contract (WRS → CPR)', () => {
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

  it('WRS outbox → EventBridge Detail validates as BaseEvent + CPR payload schema', () => {
    const outbox = WorkflowRuntimeEntityBuilder.buildOutboxEvent({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      eventId: envelope.eventId,
      detailType: OUTBOX_DETAIL_TYPE.WORKFLOW_COMPLETED,
      createdAt: envelope.timestamp,
      correlationId: envelope.meta.correlationId,
      payload: envelope as unknown as Record<string, unknown>,
    });

    const put = mapOutboxToPutEventsEntry(
      outbox,
      {
        eventBusName: 'workflow-service-bus-dev',
        eventSource: 'workflow-service',
      },
      'stream-1',
    );

    expect(put.DetailType).toBe('WorkflowCompleted.v1');
    expect(put.Source).toBe('workflow-service');

    const detail = JSON.parse(put.Detail) as unknown;
    const base = validateBaseEvent(detail);
    expect(base.eventType).toBe(WORKFLOW_COMPLETED_EVENT_TYPE);
    expect(base.source).toBe('workflow-service');
    expect(base.idempotencyKey).toBe(envelope.eventId);
    expect(base.meta.correlationId).toBe('corr-1');

    const payload = WorkflowCompletedPayloadSchema.parse(base.payload);
    const normalized = normalizeWorkflowCompletedPayload(payload);
    expect(normalized).toEqual(
      expect.objectContaining({
        sourceEventId: '01WFCOMPLETEDOUTBOX',
        orgId: 'org-1',
        patientId: 'pat-1',
        carePlanInstanceId: 'cpi-1',
        workflowType: 'PATIENT_ONBOARDING',
        outcome: 'completed',
        workflowInstanceId: 'wf-1',
        correlationId: 'corr-1',
      }),
    );
  });

  it('rejects flat catalog Detail (pre-P0#2 shape) as BaseEvent', () => {
    const flat = {
      eventId: '01EVT',
      eventType: 'WorkflowCompleted',
      eventVersion: 1,
      timestamp: '2026-08-25T00:00:00.000Z',
      organizationId: 'org-1',
      workflowId: 'wf-1',
      patientId: 'pat-1',
      carePlanId: 'cpi-1',
      workflowType: 'PATIENT_ONBOARDING',
      correlationId: 'corr-1',
      completedAt: '2026-08-25T00:00:00.000Z',
      outcome: 'completed',
    };
    expect(() => validateBaseEvent(flat)).toThrow(EventValidationError);
    expect(() => validateBaseEvent(flat)).toThrow(/Missing required field/);
  });

  it.each([
    'eventId',
    'eventType',
    'eventVersion',
    'timestamp',
    'source',
    'idempotencyKey',
    'payload',
  ] as const)('rejects BaseEvent missing %s', (field) => {
    const broken = { ...envelope } as Record<string, unknown>;
    delete broken[field];
    expect(() => validateBaseEvent(broken)).toThrow(/Missing required field/);
  });

  it('rejects BaseEvent when domain payload lacks carePlanId/organizationId', () => {
    const brokenPayload = {
      sourceEventId: envelope.eventId,
      patientId: 'pat-1',
      workflowType: 'PATIENT_ONBOARDING',
      outcome: 'completed',
    };
    expect(() => WorkflowCompletedPayloadSchema.parse(brokenPayload)).toThrow();
  });

  it('rejects BaseEvent when domain payload lacks patientId', () => {
    const brokenPayload = {
      sourceEventId: envelope.eventId,
      organizationId: 'org-1',
      carePlanId: 'cpi-1',
      workflowType: 'PATIENT_ONBOARDING',
      outcome: 'completed',
    };
    expect(() => WorkflowCompletedPayloadSchema.parse(brokenPayload)).toThrow();
  });
});
