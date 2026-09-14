import { createWorkflowTemplateHttpBodySchema } from '../validators/workflow-template.schemas';
import {
  WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION,
  parseWorkflowTemplateHttpBody,
  workflowTemplateZodErrorToBaseError,
} from './workflow-template-validation-http-error';

function validChecklist(overrides: Record<string, unknown> = {}) {
  return {
    checklistId: 'confirmName',
    itemName: 'Confirm name',
    instruction: 'Match ID',
    required: true,
    allowSkip: false,
    allowDefer: false,
    active: true,
    sortOrder: 1,
    ...overrides,
  };
}

function validStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 'verifyDemographics',
    name: 'Verify demographics',
    instructions: 'Check ID',
    requirement: 'mandatory',
    allowSkip: false,
    allowDefer: false,
    condition: null,
    sortOrder: 1,
    checklists: [validChecklist()],
    ...overrides,
  };
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    templateName: 'Patient Onboarding Workflow',
    workflowType: 'PATIENT_ONBOARDING',
    workflowStage: 'PATIENT_ONBOARDING',
    description: 'desc',
    steps: [validStep()],
    ...overrides,
  };
}

function assertGenericValidationDescription(description: string): void {
  expect(description).toBe(WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION);
  expect(description).not.toContain('steps.');
  expect(description).not.toContain('checklists.');
  expect(description).not.toMatch(/Too small/i);
}

describe('workflowTemplateZodErrorToBaseError', () => {
  it('maps multiple template issues to generic description and structured details', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody({
        steps: [
          validStep({ stepId: 'step-test', sortOrder: 1 }),
          validStep({
            stepId: 'step-test',
            sortOrder: 2,
            checklists: [validChecklist({ itemName: '' })],
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const error = workflowTemplateZodErrorToBaseError(parsed.error);

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe(WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION);
    expect(error.details).toEqual(
      expect.arrayContaining([
        {
          field: 'steps.1.checklists.0.itemName',
          message: 'Please enter a checklist item.',
        },
        {
          field: 'steps.1.stepId',
          message: 'Duplicate stepId: step-test',
        },
      ]),
    );
    assertGenericValidationDescription(error.message);
  });

  it('uses the same generic description for a single field error', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody({
        steps: [
          validStep({
            checklists: [validChecklist({ itemName: '' })],
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const error = workflowTemplateZodErrorToBaseError(parsed.error);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    assertGenericValidationDescription(error.message);
    expect(error.details).toEqual(
      expect.arrayContaining([
        {
          field: 'steps.0.checklists.0.itemName',
          message: 'Please enter a checklist item.',
        },
      ]),
    );
  });
});

describe('parseWorkflowTemplateHttpBody', () => {
  it('returns parsed data when the body is valid', () => {
    const body = parseWorkflowTemplateHttpBody<Record<string, unknown>>(
      createWorkflowTemplateHttpBodySchema,
      validCreateBody(),
    );
    expect(body.templateName).toBe('Patient Onboarding Workflow');
  });

  it('throws BaseError without mutating validation rules', () => {
    expect(() =>
      parseWorkflowTemplateHttpBody(
        createWorkflowTemplateHttpBodySchema,
        validCreateBody({
          steps: [
            validStep({
              checklists: [validChecklist({ checklistId: '', itemName: '' })],
            }),
          ],
        }),
      ),
    ).toThrow(WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION);
  });
});
