/**
 * P0 #3 — WorkflowCompleted lifecycle outcome contract with CPR.
 */
import {
  WORKFLOW_LIFECYCLE_OUTCOME,
  WORKFLOW_TYPE,
  buildWorkflowCompletedBaseEvent,
  isWorkflowLifecycleOutcome,
} from '@api-hub/workflow-runtime-core';

import {
  WorkflowCompletedPayloadSchema,
  normalizeWorkflowCompletedPayload,
} from '../../../care-plan-runtime/src/handlers/events/inbound/workflow-completed.event';
import { completeWorkflowHttpBodySchema } from '../validators/workflow-runtime.schemas';

describe('WorkflowCompleted lifecycle outcome (P0 #3)', () => {
  it('allows only completed on CompleteWorkflow HTTP body', () => {
    expect(
      completeWorkflowHttpBodySchema.parse({ outcome: 'completed' }).outcome,
    ).toBe(WORKFLOW_LIFECYCLE_OUTCOME.COMPLETED);
    expect(() =>
      completeWorkflowHttpBodySchema.parse({ outcome: 'approved' }),
    ).toThrow();
    expect(() =>
      completeWorkflowHttpBodySchema.parse({ outcome: 'cancelled' }),
    ).toThrow();
    expect(() => completeWorkflowHttpBodySchema.parse({})).toThrow();
  });

  it('recognizes CPR lifecycle outcomes', () => {
    expect(isWorkflowLifecycleOutcome('completed')).toBe(true);
    expect(isWorkflowLifecycleOutcome('cancelled')).toBe(true);
    expect(isWorkflowLifecycleOutcome('approved')).toBe(false);
  });

  it.each([
    WORKFLOW_TYPE.PATIENT_ONBOARDING,
    WORKFLOW_TYPE.FORMAL_REVIEW,
    WORKFLOW_TYPE.CLOSURE_REVIEW,
  ] as const)(
    '%s completion envelope carries outcome=completed for CPR',
    (workflowType) => {
      const envelope = buildWorkflowCompletedBaseEvent({
        eventId: `evt-${workflowType}`,
        timestamp: '2026-08-25T00:00:00.000Z',
        organizationId: 'org-1',
        workflowId: 'wf-1',
        patientId: 'pat-1',
        carePlanId: 'cpi-1',
        workflowType,
        correlationId: 'corr-1',
        completedAt: '2026-08-25T00:00:00.000Z',
        outcome: WORKFLOW_LIFECYCLE_OUTCOME.COMPLETED,
      });

      const payload = WorkflowCompletedPayloadSchema.parse(envelope.payload);
      const normalized = normalizeWorkflowCompletedPayload(payload);
      expect(normalized.outcome).toBe('completed');
      expect(normalized.workflowType).toBe(workflowType);
    },
  );

  it('CPR payload schema accepts cancelled and rejects approved', () => {
    const base = {
      sourceEventId: 'e1',
      organizationId: 'org-1',
      patientId: 'pat-1',
      carePlanId: 'cpi-1',
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
    };
    expect(
      WorkflowCompletedPayloadSchema.parse({
        ...base,
        outcome: 'cancelled',
      }).outcome,
    ).toBe('cancelled');
    expect(() =>
      WorkflowCompletedPayloadSchema.parse({
        ...base,
        outcome: 'approved',
      }),
    ).toThrow();
  });
});
