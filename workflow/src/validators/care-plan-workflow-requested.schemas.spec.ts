import { carePlanWorkflowRequestedPayloadSchema } from './care-plan-workflow-requested.schemas';

const valid = {
  eventId: 'evt-1',
  eventType: 'CarePlanWorkflowRequested.v1' as const,
  eventVersion: 1 as const,
  timestamp: '2026-07-22T10:00:00.000Z',
  organizationId: 'org-1',
  patientId: 'pat-1',
  carePlanId: 'cpi-1',
  workflowType: 'PATIENT_ONBOARDING' as const,
  carePlanTemplateId: 'HTN-CARE-PLAN',
  workflowStage: 'PATIENT_ONBOARDING' as const,
  correlationId: 'corr-1',
};

describe('carePlanWorkflowRequestedPayloadSchema', () => {
  it('accepts valid event with carePlanTemplateId', () => {
    const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('accepts missing carePlanTemplateId (legacy snapshot path)', () => {
    const { carePlanTemplateId: _omit, ...without } = valid;
    const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse(without);
    expect(parsed.success).toBe(true);
  });

  it.each(['FORMAL_REVIEW', 'CLOSURE_REVIEW'] as const)(
    'accepts workflowType %s',
    (workflowType) => {
      const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse({
        ...valid,
        workflowType,
        workflowStage: workflowType,
      });
      expect(parsed.success).toBe(true);
    },
  );

  it('rejects camelCase workflowType patientOnboarding at schema layer (mapper normalizes first)', () => {
    const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse({
      ...valid,
      workflowType: 'patientOnboarding',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown workflowType values such as template ids', () => {
    const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse({
      ...valid,
      workflowType: 'O1A',
    });
    expect(parsed.success).toBe(false);
  });
});
