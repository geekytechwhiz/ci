import {
  STEP_STATUS,
  toWorkflowAggregateView,
  WORKFLOW_STATUS,
  WORKFLOW_TYPE,
  WorkflowRuntimeEntityBuilder,
} from '@api-hub/workflow-runtime-core';

import { WorkflowQueryProjectionService } from './workflow-query-projection.service';

const ORG = 'org-1';
const WF = 'wf-1';
const STEP = 'step-1';
const CL = 'cl-1';
const TS = '2026-07-01T00:00:00.000Z';

function buildAggregate(stepStatus = STEP_STATUS.IN_PROGRESS) {
  const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
    organizationId: ORG,
    workflowId: WF,
    workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
    definitionVersion: '0000000001',
    patientId: 'pat-1',
    carePlanId: 'cp-1',
    workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
    createdAt: TS,
    updatedAt: TS,
    recordVersion: 1,
  });
  const step = WorkflowRuntimeEntityBuilder.buildStep({
    organizationId: ORG,
    workflowId: WF,
    stepId: STEP,
    name: 'Review',
    stepStatus,
    sortOrder: 1,
    requirement: 'mandatory',
    allowSkip: false,
    allowDefer: false,
    createdAt: TS,
    updatedAt: TS,
    recordVersion: 1,
  });
  return toWorkflowAggregateView(workflow, [step]);
}

function buildChecklist(status = STEP_STATUS.NOT_STARTED) {
  return WorkflowRuntimeEntityBuilder.buildChecklist({
    organizationId: ORG,
    workflowId: WF,
    stepId: STEP,
    checklistId: CL,
    itemName: 'Confirm identity',
    required: true,
    allowSkip: false,
    allowDefer: false,
    checklistStatus: status,
    active: true,
    sortOrder: 1,
    createdAt: TS,
    updatedAt: TS,
    recordVersion: 1,
  });
}

describe('WorkflowQueryProjectionService', () => {
  const svc = new WorkflowQueryProjectionService();

  it('buildCompletionReadiness with empty checklists omits checklist gaps', () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const readiness = svc.buildCompletionReadiness(aggregate, []);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingRequirements).toHaveLength(1);
    expect(readiness.missingRequirements[0]).toMatchObject({ stepId: STEP });
    expect(readiness.missingRequirements[0].checklistId).toBeUndefined();
    expect(readiness.completionSummary.totalChecklistItems).toBe(0);
  });

  it('buildCompletionReadiness with checklists matches workflow complete evaluator', () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const checklists = [buildChecklist(STEP_STATUS.NOT_STARTED)];
    const readiness = svc.buildCompletionReadiness(aggregate, checklists);
    expect(readiness.ready).toBe(false);
    expect(readiness.missingRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: STEP,
          reason: expect.stringContaining('Step must be completed'),
        }),
        expect.objectContaining({
          stepId: STEP,
          checklistId: CL,
          reason: expect.stringContaining('Blocking checklist must be completed'),
        }),
      ]),
    );
    expect(readiness.completionSummary).toEqual(
      expect.objectContaining({
        totalChecklistItems: 1,
        requiredChecklistItems: 1,
        completedRequiredChecklistItems: 0,
      }),
    );
  });

  it('buildCompletionReadiness ready when steps and required checklists satisfied', () => {
    const aggregate = buildAggregate(STEP_STATUS.COMPLETED);
    const checklists = [buildChecklist(STEP_STATUS.COMPLETED)];
    const readiness = svc.buildCompletionReadiness(aggregate, checklists);
    expect(readiness.ready).toBe(true);
    expect(readiness.missingRequirements).toHaveLength(0);
  });

  it('buildWorkbench surfaces checklist blockers in missingRequirements', async () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const checklists = [buildChecklist(STEP_STATUS.NOT_STARTED)];
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists,
      evidenceItems: [],
    });
    expect(workbench.ctas.canComplete).toBe(false);
    expect(workbench.missingRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: STEP, checklistId: CL }),
      ]),
    );
  });

  it('buildWorkbench surfaces step instructions on stepsTracker', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Review',
      instructions: 'Complete patient onboarding',
      stepStatus: STEP_STATUS.IN_PROGRESS,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const workbench = await svc.buildWorkbench({
      aggregate: toWorkflowAggregateView(workflow, [step]),
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0].instructions).toBe(
      'Complete patient onboarding',
    );
  });

  it('buildWorkbench omits instructions for legacy steps', async () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0]).not.toHaveProperty('instructions');
  });

  it('buildWorkbench surfaces step linkedAction on stepsTracker', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Patient Setup',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      linkedAction: { actionCode: 'OPEN_BASELINE' },
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const workbench = await svc.buildWorkbench({
      aggregate: toWorkflowAggregateView(workflow, [step]),
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0].linkedAction).toEqual({
      actionCode: 'OPEN_BASELINE',
    });
  });

  it('buildWorkbench omits linkedAction for legacy steps', async () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0]).not.toHaveProperty('linkedAction');
  });

  it('buildWorkbench preserves distinct linkedAction codes per step', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'Patient Setup',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        linkedAction: { actionCode: 'OPEN_BASELINE' },
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's2',
        name: 'Device Setup',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 2,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        linkedAction: { actionCode: 'OPEN_DEVICE_SETUP' },
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's3',
        name: 'Manual Confirm',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 3,
        requirement: 'optional',
        allowSkip: true,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const workbench = await svc.buildWorkbench({
      aggregate: toWorkflowAggregateView(workflow, steps),
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker).toHaveLength(3);
    expect(workbench.stepsTracker[0].linkedAction).toEqual({
      actionCode: 'OPEN_BASELINE',
    });
    expect(workbench.stepsTracker[1].linkedAction).toEqual({
      actionCode: 'OPEN_DEVICE_SETUP',
    });
    expect(workbench.stepsTracker[2]).not.toHaveProperty('linkedAction');
  });

  it('buildWorkbench does not copy checklist linkedAction onto stepsTracker', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Review',
      stepStatus: STEP_STATUS.IN_PROGRESS,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      linkedAction: { actionCode: 'OPEN_BASELINE' },
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const checklist = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      checklistId: CL,
      itemName: 'Verify labs',
      required: true,
      allowSkip: false,
      allowDefer: false,
      checklistStatus: STEP_STATUS.NOT_STARTED,
      active: true,
      sortOrder: 1,
      linkedAction: { actionCode: 'OPEN_LABS' },
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const workbench = await svc.buildWorkbench({
      aggregate: toWorkflowAggregateView(workflow, [step]),
      checklists: [checklist],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0].linkedAction).toEqual({
      actionCode: 'OPEN_BASELINE',
    });
    expect(workbench).not.toHaveProperty('checklists');
    expect(workbench.stepsTracker[0].checklists).toHaveLength(1);
    expect(workbench.stepsTracker[0].checklists[0].linkedAction).toEqual({
      actionCode: 'OPEN_LABS',
    });
  });

  it('buildWorkbench nests checklists under the matching stepId', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.FORMAL_REVIEW,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'Patient Setup',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's2',
        name: 'Device Setup',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 2,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's3',
        name: 'Manual Confirm',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 3,
        requirement: 'optional',
        allowSkip: true,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const checklists = [
      WorkflowRuntimeEntityBuilder.buildChecklist({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's2',
        checklistId: 'chk-b',
        itemName: 'Pair device',
        instruction: 'Pair the kit',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: STEP_STATUS.IN_PROGRESS,
        active: true,
        sortOrder: 2,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildChecklist({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's2',
        checklistId: 'chk-a',
        itemName: 'Unbox device',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: STEP_STATUS.COMPLETED,
        active: true,
        sortOrder: 1,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildChecklist({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        checklistId: 'chk-goals',
        itemName: 'Confirm patient care goals',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: STEP_STATUS.NOT_STARTED,
        active: true,
        sortOrder: 1,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const workbench = await svc.buildWorkbench({
      aggregate: toWorkflowAggregateView(workflow, steps),
      checklists,
      evidenceItems: [],
    });

    expect(workbench.stepsTracker.map((s) => s.stepId)).toEqual(['s1', 's2', 's3']);
    expect(workbench.stepsTracker.map((s) => s.sortOrder)).toEqual([1, 2, 3]);
    expect(workbench.stepsTracker[0].checklists.map((c) => c.checklistId)).toEqual([
      'chk-goals',
    ]);
    expect(workbench.stepsTracker[1].checklists.map((c) => c.checklistId)).toEqual([
      'chk-a',
      'chk-b',
    ]);
    expect(workbench.stepsTracker[1].checklists.map((c) => c.sortOrder)).toEqual([
      1, 2,
    ]);
    expect(workbench.stepsTracker[1].checklists[0].checklistStatus).toBe(
      STEP_STATUS.COMPLETED,
    );
    expect(workbench.stepsTracker[1].checklists[1].checklistStatus).toBe(
      STEP_STATUS.IN_PROGRESS,
    );
    expect(workbench.stepsTracker[2].checklists).toEqual([]);
    expect(workbench.progress).toEqual({ completed: 0, totalApplicable: 3 });
    expect(workbench.blockers).toEqual([]);
    expect(workbench.evidence).toEqual([]);
  });

  it('buildWorkbench returns empty checklists arrays when the workflow has none', async () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker).toHaveLength(1);
    expect(workbench.stepsTracker[0].checklists).toEqual([]);
    expect(workbench).not.toHaveProperty('checklists');
  });

  it('buildWorkbench surfaces blocked checklist status and reason', async () => {
    const aggregate = buildAggregate(STEP_STATUS.IN_PROGRESS);
    const checklist = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      checklistId: CL,
      itemName: 'Confirm identity',
      required: true,
      allowSkip: false,
      allowDefer: false,
      blocksStepCompletion: true,
      checklistStatus: STEP_STATUS.BLOCKED,
      reason: 'Patient unreachable after repeated attempts',
      active: true,
      sortOrder: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 2,
    });
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [checklist],
      evidenceItems: [],
    });

    expect(workbench.stepsTracker[0].checklists[0]).toEqual(
      expect.objectContaining({
        checklistId: CL,
        checklistStatus: STEP_STATUS.BLOCKED,
        recordVersion: 2,
        reason: 'Patient unreachable after repeated attempts',
      }),
    );
    expect(workbench.ctas.canComplete).toBe(false);
    expect(workbench.missingRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: STEP, checklistId: CL }),
      ]),
    );
  });

  it('buildWorkbench resolves assignee from matching template version for legacy instances', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      templateVersion: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Complete Patient Profile',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest.fn().mockResolvedValue({
        version: 1,
        defaultAssignee: {
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
        },
      }),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.workflow.assigneeType).toBe('role');
    expect(workbench.workflow.assigneeId).toBe('careCoordinator');
    expect(workbench.stepsTracker[0].assigneeType).toBe('role');
    expect(workbench.stepsTracker[0].assigneeId).toBe('careCoordinator');
    expect(templates.getTemplateMetadata).toHaveBeenCalledWith({
      scope: 'organization',
      organizationId: ORG,
      templateId: 'org-onboarding',
    });
  });

  it('buildWorkbench does not use current template default when templateVersion mismatches', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      templateVersion: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Complete Patient Profile',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest
        .fn()
        .mockResolvedValueOnce({
          version: 2,
          defaultAssignee: {
            assigneeType: 'role',
            assigneeId: 'nurse',
          },
        })
        .mockResolvedValueOnce(null),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [],
      evidenceItems: [],
    });

    expect(workbench.workflow).not.toHaveProperty('assigneeType');
    expect(workbench.workflow).not.toHaveProperty('assigneeId');
    expect(workbench.stepsTracker[0]).not.toHaveProperty('assigneeType');
    expect(workbench.stepsTracker[0]).not.toHaveProperty('assigneeId');
  });

  it('resolveDisplayAssignee prefers persisted workflow assignee over step and template', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      templateVersion: 1,
      assigneeType: 'user',
      assigneeId: 'usr-persisted',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Step',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      assigneeType: 'role',
      assigneeId: 'careCoordinator',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest.fn(),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);

    await expect(svc.resolveDisplayAssignee(aggregate)).resolves.toEqual({
      assigneeType: 'user',
      assigneeId: 'usr-persisted',
    });
    expect(templates.getTemplateMetadata).not.toHaveBeenCalled();
  });

  it('resolveDisplayAssignee prefers step assignee when workflow assignee is absent', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      templateVersion: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Step',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      assigneeType: 'role',
      assigneeId: 'careCoordinator',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest.fn(),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);

    await expect(svc.resolveDisplayAssignee(aggregate)).resolves.toEqual({
      assigneeType: 'role',
      assigneeId: 'careCoordinator',
    });
    expect(templates.getTemplateMetadata).not.toHaveBeenCalled();
  });

  it('resolveDisplayAssignee skips template fallback when templateVersion is missing', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Step',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest.fn(),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);

    await expect(svc.resolveDisplayAssignee(aggregate)).resolves.toBeUndefined();
    expect(templates.getTemplateMetadata).not.toHaveBeenCalled();
  });

  it('resolveDisplayAssignee uses matching template default for legacy workflows without persisted assignee', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      sourceTemplateId: 'org-onboarding',
      templateVersion: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 2,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Step',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const templates = {
      getTemplateMetadata: jest.fn().mockResolvedValue({
        version: 1,
        defaultAssignee: {
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
        },
      }),
    };
    const svc = new WorkflowQueryProjectionService(templates as never);

    await expect(svc.resolveDisplayAssignee(aggregate)).resolves.toEqual({
      assigneeType: 'role',
      assigneeId: 'careCoordinator',
    });
  });

  it('buildWorkbench exposes independent checklist effective assignee on nested checklists', async () => {
    const workflow = WorkflowRuntimeEntityBuilder.buildInstance({
      organizationId: ORG,
      workflowId: WF,
      workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
      definitionVersion: '0000000001',
      patientId: 'pat-1',
      carePlanId: 'cp-1',
      workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
      assigneeType: 'role',
      assigneeId: 'CARE_MANAGER',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      name: 'Patient Onboarding',
      stepStatus: STEP_STATUS.IN_PROGRESS,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      assigneeType: 'role',
      assigneeId: 'CARE_MANAGER',
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const checklistWithOverride = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      checklistId: CL,
      itemName: 'Verify patient demographics',
      required: true,
      allowSkip: false,
      allowDefer: false,
      assigneeOverride: { assigneeType: 'role', assigneeId: 'CARE_COORDINATOR' },
      checklistStatus: STEP_STATUS.COMPLETED,
      active: true,
      sortOrder: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const checklistInherited = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: STEP,
      checklistId: 'chk-inherit',
      itemName: 'Review medical history',
      required: true,
      allowSkip: false,
      allowDefer: false,
      checklistStatus: STEP_STATUS.COMPLETED,
      active: true,
      sortOrder: 2,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const aggregate = toWorkflowAggregateView(workflow, [step]);
    const svc = new WorkflowQueryProjectionService();
    const workbench = await svc.buildWorkbench({
      aggregate,
      checklists: [checklistWithOverride, checklistInherited],
      evidenceItems: [],
    });

    expect(workbench.workflow.assigneeType).toBe('role');
    expect(workbench.workflow.assigneeId).toBe('CARE_MANAGER');
    expect(workbench.stepsTracker[0].assigneeType).toBe('role');
    expect(workbench.stepsTracker[0].assigneeId).toBe('CARE_MANAGER');
    expect(workbench.stepsTracker[0].checklists[0]).toEqual(
      expect.objectContaining({
        checklistId: CL,
        assigneeType: 'role',
        assigneeId: 'CARE_COORDINATOR',
      }),
    );
    expect(workbench.stepsTracker[0].checklists[1]).toEqual(
      expect.objectContaining({
        checklistId: 'chk-inherit',
        assigneeType: 'role',
        assigneeId: 'CARE_MANAGER',
      }),
    );
  });
});
