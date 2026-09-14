import { toBaseError } from '@api-hub/utils';

import {
  createWorkflowTemplateHttpBodySchema,
  updateWorkflowTemplateHttpBodySchema,
} from './workflow-template.schemas';

const CHECKLIST_ITEM_ID_MESSAGE = 'Please provide a checklist item ID.';
const CHECKLIST_ITEM_NAME_MESSAGE = 'Please enter a checklist item.';
const CHECKLIST_ITEM_INCOMPLETE_MESSAGE =
  'Please complete the checklist item before saving the workflow.';

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

function assertNoRawZodTooSmall(text: string | undefined): void {
  expect(text ?? '').not.toMatch(/Too small/i);
}

describe('createWorkflowTemplateHttpBodySchema checklist messages', () => {
  it('accepts a completed checklist item', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody(),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a blank checklist item with field-level user-friendly messages', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody({
        steps: [
          validStep({
            checklists: [validChecklist({ checklistId: '', itemName: '' })],
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const details = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    expect(details).toEqual(
      expect.arrayContaining([
        {
          field: 'steps.0.checklists.0.checklistId',
          message: CHECKLIST_ITEM_ID_MESSAGE,
        },
        {
          field: 'steps.0.checklists.0.itemName',
          message: CHECKLIST_ITEM_NAME_MESSAGE,
        },
        {
          field: 'steps.0.checklists.0',
          message: CHECKLIST_ITEM_INCOMPLETE_MESSAGE,
        },
      ]),
    );
    for (const detail of details) {
      assertNoRawZodTooSmall(detail.message);
    }

    const normalized = toBaseError(parsed.error);
    expect(normalized.statusCode).toBe(400);
    expect(normalized.code).toBe('VALIDATION_ERROR');
    expect(normalized.details).toEqual(
      expect.arrayContaining([
        {
          field: 'steps.0.checklists.0.checklistId',
          message: CHECKLIST_ITEM_ID_MESSAGE,
        },
        {
          field: 'steps.0.checklists.0.itemName',
          message: CHECKLIST_ITEM_NAME_MESSAGE,
        },
      ]),
    );
    expect(normalized.message).toContain(CHECKLIST_ITEM_INCOMPLETE_MESSAGE);
    assertNoRawZodTooSmall(normalized.message);
  });

  it('rejects a whitespace-only itemName with a user-friendly field message', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody({
        steps: [
          validStep({
            checklists: [validChecklist({ itemName: '   ' })],
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['steps', 0, 'checklists', 0, 'itemName'],
          message: CHECKLIST_ITEM_NAME_MESSAGE,
        }),
      ]),
    );
    for (const issue of parsed.error.issues) {
      assertNoRawZodTooSmall(issue.message);
    }
  });

  it('rejects a blank checklistId with a user-friendly field message', () => {
    const parsed = createWorkflowTemplateHttpBodySchema.safeParse(
      validCreateBody({
        steps: [
          validStep({
            checklists: [validChecklist({ checklistId: '' })],
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['steps', 0, 'checklists', 0, 'checklistId'],
          message: CHECKLIST_ITEM_ID_MESSAGE,
        }),
      ]),
    );
    for (const issue of parsed.error.issues) {
      assertNoRawZodTooSmall(issue.message);
    }
  });
});

describe('updateWorkflowTemplateHttpBodySchema checklist messages', () => {
  it('rejects a blank checklist item on update with the same user-friendly messages', () => {
    const parsed = updateWorkflowTemplateHttpBodySchema.safeParse({
      templateName: 'Updated Onboarding',
      steps: [
        validStep({
          checklists: [validChecklist({ checklistId: '', itemName: '' })],
        }),
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const normalized = toBaseError(parsed.error);
    expect(normalized.statusCode).toBe(400);
    expect(normalized.code).toBe('VALIDATION_ERROR');
    expect(normalized.details).toEqual(
      expect.arrayContaining([
        {
          field: 'steps.0.checklists.0.itemName',
          message: CHECKLIST_ITEM_NAME_MESSAGE,
        },
        {
          field: 'steps.0.checklists.0.checklistId',
          message: CHECKLIST_ITEM_ID_MESSAGE,
        },
      ]),
    );
    expect(normalized.message).toContain(CHECKLIST_ITEM_INCOMPLETE_MESSAGE);
    assertNoRawZodTooSmall(normalized.message);
  });
});
