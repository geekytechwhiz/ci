import { toWorkflowChecklistHttpDto, toWorkflowStepHttpDto } from './workflow-runtime-http.mapper';

describe('toWorkflowStepHttpDto', () => {
  it('includes linkedAction when present on step view', () => {
    const dto = toWorkflowStepHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      name: 'Baseline',
      stepStatus: 'notStarted',
      sortOrder: 1,
      linkedAction: { actionCode: 'OPEN_BASELINE' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.linkedAction).toEqual({ actionCode: 'OPEN_BASELINE' });
  });

  it('omits linkedAction for legacy step views', () => {
    const dto = toWorkflowStepHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      name: 'Legacy',
      stepStatus: 'completed',
      sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.linkedAction).toBeUndefined();
  });

  it('includes instructions when present on the step view', () => {
    const dto = toWorkflowStepHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      name: 'Baseline',
      instructions: 'Complete patient onboarding',
      stepStatus: 'notStarted',
      sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.instructions).toBe('Complete patient onboarding');
  });

  it('omits instructions for legacy step views', () => {
    const dto = toWorkflowStepHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      name: 'Legacy',
      stepStatus: 'completed',
      sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.instructions).toBeUndefined();
  });
});

describe('toWorkflowChecklistHttpDto', () => {
  it('includes linkedAction and blocksStepCompletion when present', () => {
    const dto = toWorkflowChecklistHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      checklistId: 'c1',
      itemName: 'Verify labs',
      required: true,
      allowSkip: false,
      allowDefer: true,
      blocksStepCompletion: true,
      linkedAction: { actionCode: 'OPEN_LABS' },
      checklistStatus: 'notStarted',
      active: true,
      sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.linkedAction).toEqual({ actionCode: 'OPEN_LABS' });
    expect(dto.blocksStepCompletion).toBe(true);
    expect(dto.pk).toBeUndefined();
  });

  it('omits blocksStepCompletion for legacy checklist views', () => {
    const dto = toWorkflowChecklistHttpDto({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      stepId: 's1',
      checklistId: 'c1',
      itemName: 'Legacy item',
      required: true,
      allowSkip: true,
      allowDefer: false,
      checklistStatus: 'completed',
      active: true,
      sortOrder: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      recordVersion: 1,
    });

    expect(dto.blocksStepCompletion).toBeUndefined();
    expect(dto.linkedAction).toBeUndefined();
  });
});
