import {
  extractEventPayloadFromSqsBody,
  toCreateWorkflowCommand,
  unwrapCarePlanWorkflowRequestedDetail,
} from './care-plan-workflow-requested.mapper';
import type { CarePlanWorkflowRequestedPayload } from '../validators/care-plan-workflow-requested.schemas';

describe('care-plan-workflow-requested.mapper', () => {
  describe('unwrapCarePlanWorkflowRequestedDetail', () => {
    it('returns flat domain payloads unchanged', () => {
      const flat = {
        eventId: 'evt-1',
        eventType: 'CarePlanWorkflowRequested.v1',
        eventVersion: 1,
        organizationId: 'org-1',
        carePlanId: 'cpi-1',
      };
      expect(unwrapCarePlanWorkflowRequestedDetail(flat)).toEqual(flat);
    });

    it('lifts BaseEvent.payload and normalizes eventVersion 1.0.0 → 1', () => {
      const unwrapped = unwrapCarePlanWorkflowRequestedDetail({
        eventId: 'evt-outer',
        eventType: 'CarePlanWorkflowRequested.v1',
        eventVersion: '1.0.0',
        timestamp: '2026-07-29T10:00:00.000Z',
        source: 'care-plan-runtime-service',
        payload: {
          eventId: 'evt-inner',
          eventVersion: 1,
          timestamp: '2026-07-29T10:00:00.000Z',
          organizationId: 'org-1',
          patientId: 'pat-1',
          carePlanId: 'cpi-1',
          workflowType: 'PATIENT_ONBOARDING',
          correlationId: 'corr-1',
        },
        meta: { correlationId: 'corr-meta' },
      });

      expect(unwrapped).toEqual(
        expect.objectContaining({
          eventId: 'evt-inner',
          eventType: 'CarePlanWorkflowRequested.v1',
          eventVersion: 1,
          organizationId: 'org-1',
          patientId: 'pat-1',
          carePlanId: 'cpi-1',
          workflowType: 'PATIENT_ONBOARDING',
          correlationId: 'corr-1',
        }),
      );
    });

    it('fills correlationId from meta when missing on payload', () => {
      const unwrapped = unwrapCarePlanWorkflowRequestedDetail({
        eventId: 'evt-1',
        eventType: 'CarePlanWorkflowRequested.v1',
        eventVersion: '1.0.0',
        payload: {
          eventId: 'evt-1',
          eventVersion: 1,
          organizationId: 'org-1',
          patientId: 'pat-1',
          carePlanId: 'cpi-1',
          workflowType: 'FORMAL_REVIEW',
        },
        meta: { correlationId: 'corr-from-meta' },
      });

      expect(unwrapped).toEqual(
        expect.objectContaining({
          correlationId: 'corr-from-meta',
          eventType: 'CarePlanWorkflowRequested.v1',
        }),
      );
    });

    it('normalizes legacy camelCase workflowType to catalog SCREAMING_SNAKE', () => {
      const unwrapped = unwrapCarePlanWorkflowRequestedDetail({
        eventId: 'evt-1',
        eventType: 'CarePlanWorkflowRequested.v1',
        eventVersion: '1.0.0',
        payload: {
          eventId: 'evt-1',
          eventVersion: 1,
          timestamp: '2026-07-29T10:00:00.000Z',
          organizationId: 'org-1',
          patientId: 'pat-1',
          carePlanId: 'cpi-1',
          workflowType: 'patientOnboarding',
          correlationId: 'corr-1',
        },
        meta: { correlationId: 'corr-1' },
      });

      expect(unwrapped).toEqual(
        expect.objectContaining({
          workflowType: 'PATIENT_ONBOARDING',
        }),
      );
    });

    it.each([
      ['formalReview', 'FORMAL_REVIEW'],
      ['closureReview', 'CLOSURE_REVIEW'],
    ] as const)(
      'normalizes legacy %s → %s',
      (legacy, canonical) => {
        const unwrapped = unwrapCarePlanWorkflowRequestedDetail({
          eventId: 'evt-1',
          eventType: 'CarePlanWorkflowRequested.v1',
          eventVersion: 1,
          organizationId: 'org-1',
          patientId: 'pat-1',
          carePlanId: 'cpi-1',
          workflowType: legacy,
          correlationId: 'corr-1',
          timestamp: '2026-07-29T10:00:00.000Z',
        });
        expect(unwrapped).toEqual(
          expect.objectContaining({ workflowType: canonical }),
        );
      },
    );

    it('does not invent aliases for unknown workflowType values', () => {
      const unwrapped = unwrapCarePlanWorkflowRequestedDetail({
        eventId: 'evt-1',
        eventType: 'CarePlanWorkflowRequested.v1',
        eventVersion: 1,
        organizationId: 'org-1',
        patientId: 'pat-1',
        carePlanId: 'cpi-1',
        workflowType: 'O1A',
        correlationId: 'corr-1',
        timestamp: '2026-07-29T10:00:00.000Z',
      });
      expect(unwrapped).toEqual(
        expect.objectContaining({ workflowType: 'O1A' }),
      );
    });
  });

  describe('extractEventPayloadFromSqsBody', () => {
    it('unwraps EventBridge envelope then BaseEvent payload', () => {
      const body = JSON.stringify({
        'detail-type': 'CarePlanWorkflowRequested.v1',
        source: 'care-plan-runtime-service',
        detail: {
          eventId: 'evt-1',
          eventType: 'CarePlanWorkflowRequested.v1',
          eventVersion: '1.0.0',
          payload: {
            eventId: 'evt-1',
            eventVersion: 1,
            timestamp: '2026-07-29T10:00:00.000Z',
            organizationId: 'org-1',
            patientId: 'pat-1',
            carePlanId: 'cpi-1',
            workflowType: 'CLOSURE_REVIEW',
            correlationId: 'corr-1',
          },
          meta: { correlationId: 'corr-1' },
        },
      });

      expect(extractEventPayloadFromSqsBody(body)).toEqual(
        expect.objectContaining({
          organizationId: 'org-1',
          workflowType: 'CLOSURE_REVIEW',
          eventVersion: 1,
        }),
      );
    });
  });

  describe('toCreateWorkflowCommand', () => {
    const basePayload = {
      eventId: 'evt-1',
      eventType: 'CarePlanWorkflowRequested.v1' as const,
      eventVersion: 1 as const,
      timestamp: '2026-07-20T10:00:00.000Z',
      organizationId: 'org-1',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowType: 'PATIENT_ONBOARDING' as const,
      carePlanTemplateId: 'cpt-1',
      correlationId: 'corr-1',
    };

    it('maps required carePlanTemplateId and defaults', () => {
      const cmd = toCreateWorkflowCommand(
        basePayload as CarePlanWorkflowRequestedPayload,
      );
      expect(cmd.carePlanTemplateId).toBe('cpt-1');
      expect(cmd.workflowStage).toBeUndefined();
      expect(cmd.idempotencyPayload).toEqual(
        expect.objectContaining({
          carePlanTemplateId: 'cpt-1',
          workflowStage: null,
          autoStart: true,
          contextKey: 'default',
        }),
      );
    });

    it('forwards optional workflowStage', () => {
      const cmd = toCreateWorkflowCommand({
        ...basePayload,
        carePlanTemplateId: 'cpt-1',
        workflowStage: 'PATIENT_ONBOARDING',
      } as CarePlanWorkflowRequestedPayload);
      expect(cmd.carePlanTemplateId).toBe('cpt-1');
      expect(cmd.workflowStage).toBe('PATIENT_ONBOARDING');
      expect(cmd.idempotencyPayload).toEqual(
        expect.objectContaining({
          carePlanTemplateId: 'cpt-1',
          workflowStage: 'PATIENT_ONBOARDING',
        }),
      );
    });
  });
});
