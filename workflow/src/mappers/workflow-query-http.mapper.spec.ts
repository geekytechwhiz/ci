import {
  STEP_STATUS,
  WORKFLOW_STATUS,
  WORKFLOW_TYPE,
  WorkflowRuntimeEntityBuilder,
  toWorkflowAggregateView,
} from '@api-hub/workflow-runtime-core';

import { toStepTrackerDto, toWorkbenchChecklistDto } from './workflow-query-http.mapper';

const ORG = 'org-1';
const WF = 'wf-1';
const TS = '2026-07-01T00:00:00.000Z';

describe('workflow-query-http.mapper workbench checklists', () => {
  it('toWorkbenchChecklistDto maps runtime checklist fields including status', () => {
    const record = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: 's1',
      checklistId: 'chk-1',
      itemName: 'Confirm goals',
      instruction: 'Talk to the patient',
      required: true,
      allowSkip: false,
      allowDefer: false,
      blocksStepCompletion: true,
      linkedAction: { actionCode: 'OPEN_GOALS' },
      checklistStatus: STEP_STATUS.IN_PROGRESS,
      active: true,
      sortOrder: 3,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });

    expect(toWorkbenchChecklistDto(record)).toEqual({
      checklistId: 'chk-1',
      itemName: 'Confirm goals',
      instruction: 'Talk to the patient',
      required: true,
      allowSkip: false,
      allowDefer: false,
      blocksStepCompletion: true,
      linkedAction: { actionCode: 'OPEN_GOALS' },
      checklistStatus: STEP_STATUS.IN_PROGRESS,
      recordVersion: 1,
      sortOrder: 3,
    });
  });

  it('toWorkbenchChecklistDto returns persisted recordVersion without defaulting', () => {
    const recordV5 = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: 's1',
      checklistId: 'chk-mutated',
      itemName: 'Mutated item',
      required: true,
      allowSkip: false,
      allowDefer: false,
      checklistStatus: STEP_STATUS.IN_PROGRESS,
      active: true,
      sortOrder: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 5,
    });

    expect(toWorkbenchChecklistDto(recordV5).recordVersion).toBe(5);
    expect(toWorkbenchChecklistDto(recordV5).checklistStatus).toBe(
      STEP_STATUS.IN_PROGRESS,
    );
  });

  it('toStepTrackerDto preserves individual recordVersion per checklist', () => {
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'One',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
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
        stepId: 's1',
        checklistId: 'chk-a',
        itemName: 'A',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.NOT_STARTED,
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
        checklistId: 'chk-b',
        itemName: 'B',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.IN_PROGRESS,
        active: true,
        sortOrder: 2,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 4,
      }),
      WorkflowRuntimeEntityBuilder.buildChecklist({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        checklistId: 'chk-c',
        itemName: 'C',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.COMPLETED,
        active: true,
        sortOrder: 3,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 2,
      }),
    ];
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
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
      }),
      steps,
    );

    const versions = toStepTrackerDto(aggregate.steps, checklists)[0].checklists.map(
      (c) => c.recordVersion,
    );
    expect(versions).toEqual([1, 4, 2]);
  });

  it('toWorkbenchChecklistDto includes reason when present', () => {
    const record = WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: 's1',
      checklistId: 'chk-1',
      itemName: 'Confirm goals',
      required: true,
      allowSkip: false,
      allowDefer: false,
      checklistStatus: STEP_STATUS.BLOCKED,
      reason: 'Waiting on another team or provider',
      active: true,
      sortOrder: 1,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 2,
    });

    expect(toWorkbenchChecklistDto(record).reason).toBe(
      'Waiting on another team or provider',
    );
    expect(toWorkbenchChecklistDto(record).checklistStatus).toBe(
      STEP_STATUS.BLOCKED,
    );
    expect(toWorkbenchChecklistDto(record).recordVersion).toBe(2);
  });

  it('toStepTrackerDto groups checklists by stepId and keeps empty arrays', () => {
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'One',
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
        name: 'Two',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 2,
        requirement: 'mandatory',
        allowSkip: false,
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
        stepId: 's1',
        checklistId: 'chk-2',
        itemName: 'Second',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.NOT_STARTED,
        active: true,
        sortOrder: 2,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      WorkflowRuntimeEntityBuilder.buildChecklist({
        organizationId: ORG,
        workflowId: WF,
        stepId: 'orphan',
        checklistId: 'chk-x',
        itemName: 'Orphan',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.NOT_STARTED,
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
        checklistId: 'chk-1',
        itemName: 'First',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: STEP_STATUS.COMPLETED,
        active: true,
        sortOrder: 1,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
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
      }),
      steps,
    );

    const tracker = toStepTrackerDto(aggregate.steps, checklists);

    expect(tracker[0].checklists.map((c) => c.checklistId)).toEqual([
      'chk-1',
      'chk-2',
    ]);
    expect(tracker[1].checklists).toEqual([]);
    expect(tracker.some((s) => s.stepId === 'orphan')).toBe(false);
  });

  it('toStepTrackerDto exposes step assigneeType and assigneeId when present', () => {
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'Complete Patient Profile',
        stepStatus: STEP_STATUS.IN_PROGRESS,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        assigneeType: 'role',
        assigneeId: 'careCoordinator',
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      steps,
    );

    const tracker = toStepTrackerDto(aggregate.steps, []);

    expect(tracker[0].assigneeType).toBe('role');
    expect(tracker[0].assigneeId).toBe('careCoordinator');
  });

  it('toStepTrackerDto omits assignee fields when the step has none', () => {
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'Unassigned',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      steps,
    );

    const tracker = toStepTrackerDto(aggregate.steps, []);

    expect(tracker[0]).not.toHaveProperty('assigneeType');
    expect(tracker[0]).not.toHaveProperty('assigneeId');
  });

  it('toStepTrackerDto inherits workflow display assignee when the step has none', () => {
    const steps = [
      WorkflowRuntimeEntityBuilder.buildStep({
        organizationId: ORG,
        workflowId: WF,
        stepId: 's1',
        name: 'Verify Contact & Insurance Details',
        stepStatus: STEP_STATUS.NOT_STARTED,
        sortOrder: 1,
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: false,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
    ];
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      steps,
    );

    const tracker = toStepTrackerDto(aggregate.steps, [], {
      assigneeType: 'role',
      assigneeId: 'careCoordinator',
    });

    expect(tracker[0].assigneeType).toBe('role');
    expect(tracker[0].assigneeId).toBe('careCoordinator');
  });

  function buildStepWithAssignee(
    assigneeType: string,
    assigneeId: string,
    stepId = 's1',
  ) {
    return WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId,
      name: 'Patient Onboarding',
      stepStatus: STEP_STATUS.IN_PROGRESS,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      assigneeType: assigneeType as 'role',
      assigneeId,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
  }

  function buildChecklist(input: {
    checklistId: string;
    itemName: string;
    assigneeOverride?: { assigneeType: 'role'; assigneeId: string };
    assigneeType?: 'role' | 'user';
    assigneeId?: string;
  }) {
    return WorkflowRuntimeEntityBuilder.buildChecklist({
      organizationId: ORG,
      workflowId: WF,
      stepId: 's1',
      checklistId: input.checklistId,
      itemName: input.itemName,
      required: true,
      allowSkip: false,
      allowDefer: false,
      checklistStatus: STEP_STATUS.COMPLETED,
      active: true,
      sortOrder: 1,
      ...(input.assigneeOverride ? { assigneeOverride: input.assigneeOverride } : {}),
      ...(input.assigneeType ? { assigneeType: input.assigneeType } : {}),
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
  }

  it('toWorkbenchChecklistDto exposes checklist override assignee distinct from step', () => {
    const step = buildStepWithAssignee('role', 'CARE_MANAGER');
    const checklist = buildChecklist({
      checklistId: 'chk-demo',
      itemName: 'Verify patient demographics',
      assigneeOverride: { assigneeType: 'role', assigneeId: 'CARE_COORDINATOR' },
    });
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      [step],
    );

    const tracker = toStepTrackerDto(aggregate.steps, [checklist]);

    expect(tracker[0].assigneeType).toBe('role');
    expect(tracker[0].assigneeId).toBe('CARE_MANAGER');
    expect(tracker[0].checklists[0].assigneeType).toBe('role');
    expect(tracker[0].checklists[0].assigneeId).toBe('CARE_COORDINATOR');
  });

  it('toWorkbenchChecklistDto inherits step assignee when checklist has no override', () => {
    const step = buildStepWithAssignee('role', 'CARE_MANAGER');
    const checklist = buildChecklist({
      checklistId: 'chk-inherit',
      itemName: 'Review medical history',
    });
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      [step],
    );

    const tracker = toStepTrackerDto(aggregate.steps, [checklist]);

    expect(tracker[0].checklists[0].assigneeType).toBe('role');
    expect(tracker[0].checklists[0].assigneeId).toBe('CARE_MANAGER');
  });

  it('toWorkbenchChecklistDto prefers runtime checklist assignee over override', () => {
    const step = buildStepWithAssignee('role', 'CARE_MANAGER');
    const checklist = buildChecklist({
      checklistId: 'chk-runtime',
      itemName: 'Confirm care goals',
      assigneeOverride: { assigneeType: 'role', assigneeId: 'CARE_COORDINATOR' },
      assigneeType: 'role',
      assigneeId: 'RUNTIME_ASSIGNEE',
    });
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      [step],
    );

    const tracker = toStepTrackerDto(aggregate.steps, [checklist]);

    expect(tracker[0].checklists[0].assigneeId).toBe('RUNTIME_ASSIGNEE');
  });

  it('toWorkbenchChecklistDto omits assignee when step and checklist have none', () => {
    const step = WorkflowRuntimeEntityBuilder.buildStep({
      organizationId: ORG,
      workflowId: WF,
      stepId: 's1',
      name: 'Unassigned',
      stepStatus: STEP_STATUS.NOT_STARTED,
      sortOrder: 1,
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      createdAt: TS,
      updatedAt: TS,
      recordVersion: 1,
    });
    const checklist = buildChecklist({
      checklistId: 'chk-none',
      itemName: 'No assignee',
    });
    const aggregate = toWorkflowAggregateView(
      WorkflowRuntimeEntityBuilder.buildInstance({
        organizationId: ORG,
        workflowId: WF,
        workflowType: WORKFLOW_TYPE.PATIENT_ONBOARDING,
        definitionVersion: '0000000001',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowStatus: WORKFLOW_STATUS.IN_PROGRESS,
        createdAt: TS,
        updatedAt: TS,
        recordVersion: 1,
      }),
      [step],
    );

    const tracker = toStepTrackerDto(aggregate.steps, [checklist]);

    expect(tracker[0].checklists[0]).not.toHaveProperty('assigneeType');
    expect(tracker[0].checklists[0]).not.toHaveProperty('assigneeId');
  });

  it('toWorkbenchChecklistDto without step omits assignee fields', () => {
    const checklist = buildChecklist({
      checklistId: 'chk-no-step',
      itemName: 'Standalone',
      assigneeOverride: { assigneeType: 'role', assigneeId: 'CARE_COORDINATOR' },
    });

    expect(toWorkbenchChecklistDto(checklist)).not.toHaveProperty('assigneeType');
    expect(toWorkbenchChecklistDto(checklist)).not.toHaveProperty('assigneeId');
  });
});
