import {
  toWorkflowChecklistView,
  WorkflowChecklistAssignmentService,
  type WorkflowAuditView,
  type WorkflowChecklistDdbRecord,
  type WorkflowEvidenceView,
  type WorkflowInstanceView,
  type WorkflowNoteView,
  type WorkflowStepDdbRecord,
  type WorkflowStepView,
} from '@api-hub/workflow-runtime-core';

import {
  toWorkflowInstanceHttpDto,
  toWorkflowStepHttpDto,
  type WorkflowInstanceHttpDto,
  type WorkflowStepHttpDto,
} from './workflow-runtime-http.mapper';

export type WorkflowNoteHttpDto = {
  organizationId: string;
  workflowId: string;
  noteId: string;
  text: string;
  stepId?: string;
  createdAt: string;
  createdBy?: string;
};

export type WorkflowEvidenceHttpDto = {
  organizationId: string;
  workflowId: string;
  evidenceId: string;
  stepId: string;
  refType: string;
  refId: string;
  label?: string;
  addedBy?: string;
  addedAt: string;
};

export type WorkflowAuditHttpDto = {
  organizationId: string;
  workflowId: string;
  auditId: string;
  action: string;
  actorId?: string;
  actorType?: string;
  timestamp: string;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  correlationId?: string;
  stepId?: string;
};

export type WorkflowAssigneeDisplayRef = {
  assigneeType: string;
  assigneeId: string;
};

/** First step assignee by sortOrder (runtime snapshot / query read model). */
export function resolveAssigneeFromSteps(
  steps: WorkflowStepView[],
): WorkflowAssigneeDisplayRef | undefined {
  const sorted = [...steps].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.stepId.localeCompare(b.stepId),
  );
  for (const step of sorted) {
    if (step.assigneeType !== undefined && step.assigneeId !== undefined) {
      return { assigneeType: step.assigneeType, assigneeId: step.assigneeId };
    }
  }
  return undefined;
}

/** Read-model only: fill missing workflow assignee for HTTP display (does not persist). */
export function applyDisplayAssigneeToWorkflowView(
  workflow: WorkflowInstanceView,
  assignee: WorkflowAssigneeDisplayRef,
): WorkflowInstanceView {
  if (workflow.assigneeType !== undefined) {
    return workflow;
  }
  return {
    ...workflow,
    assigneeType: assignee.assigneeType as WorkflowInstanceView['assigneeType'],
    assigneeId: assignee.assigneeId,
  };
}

function resolveStepDisplayAssignee(
  step: WorkflowStepView,
  workflowAssignee?: WorkflowAssigneeDisplayRef,
): WorkflowAssigneeDisplayRef | undefined {
  if (step.assigneeType !== undefined && step.assigneeId !== undefined) {
    return { assigneeType: step.assigneeType, assigneeId: step.assigneeId };
  }
  return workflowAssignee;
}

export type WorkflowQueueRowHttpDto = {
  workflowId: string;
  workflowType: string;
  patientId: string;
  carePlanId: string;
  workflowStatus: string;
  dueAt?: string;
  assigneeType?: string;
  assigneeId?: string;
  blockersSummary?: string;
};

export function toWorkflowNoteHttpDto(view: WorkflowNoteView): WorkflowNoteHttpDto {
  return {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    noteId: view.noteId,
    text: view.text,
    ...(view.stepId !== undefined ? { stepId: view.stepId } : {}),
    createdAt: view.createdAt,
    ...(view.createdBy !== undefined ? { createdBy: view.createdBy } : {}),
  };
}

export function toWorkflowEvidenceHttpDto(
  view: WorkflowEvidenceView,
): WorkflowEvidenceHttpDto {
  return {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    evidenceId: view.evidenceId,
    stepId: view.stepId,
    refType: view.refType,
    refId: view.refId,
    ...(view.label !== undefined ? { label: view.label } : {}),
    ...(view.addedBy !== undefined ? { addedBy: view.addedBy } : {}),
    addedAt: view.addedAt,
  };
}

export function toWorkflowAuditHttpDto(view: WorkflowAuditView): WorkflowAuditHttpDto {
  return {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    auditId: view.auditId,
    action: view.action,
    ...(view.actorId !== undefined ? { actorId: view.actorId } : {}),
    ...(view.actorType !== undefined ? { actorType: view.actorType } : {}),
    timestamp: view.timestamp,
    ...(view.reason !== undefined ? { reason: view.reason } : {}),
    ...(view.before !== undefined ? { before: view.before } : {}),
    ...(view.after !== undefined ? { after: view.after } : {}),
    ...(view.correlationId !== undefined ? { correlationId: view.correlationId } : {}),
    ...(view.stepId !== undefined ? { stepId: view.stepId } : {}),
  };
}

export function toQueueRowHttpDto(
  view: Parameters<typeof toWorkflowInstanceHttpDto>[0],
): WorkflowQueueRowHttpDto {
  return {
    workflowId: view.workflowId,
    workflowType: view.workflowType,
    patientId: view.patientId,
    carePlanId: view.carePlanId,
    workflowStatus: view.workflowStatus,
    ...(view.dueAt !== undefined ? { dueAt: view.dueAt } : {}),
    ...(view.assigneeType !== undefined ? { assigneeType: view.assigneeType } : {}),
    ...(view.assigneeId !== undefined ? { assigneeId: view.assigneeId } : {}),
  };
}

export function toPaginatedHttpDto<T>(page: {
  items: T[];
  nextCursor?: string;
}): { items: T[]; nextCursor: string | null } {
  return {
    items: page.items,
    nextCursor: page.nextCursor ?? null,
  };
}

export type {
  WorkflowInstanceHttpDto,
  WorkflowStepHttpDto,
};

export { toWorkflowInstanceHttpDto, toWorkflowStepHttpDto };

const checklistAssignment = new WorkflowChecklistAssignmentService();

/** Nested checklist item on workbench stepsTracker (runtime fields from existing checklist records). */
export type WorkflowWorkbenchChecklistHttpDto = {
  checklistId: string;
  itemName: string;
  instruction?: string;
  required: boolean;
  allowSkip: boolean;
  allowDefer: boolean;
  blocksStepCompletion?: boolean;
  linkedAction?: { actionCode: string };
  checklistStatus: string;
  /** Persisted OCC version from the runtime checklist record. */
  recordVersion: number;
  /** Present after skip/defer/block/cancel (and other reason-bearing actions). */
  reason?: string;
  sortOrder: number;
  /**
   * Effective assignee for PDP display (runtime checklist → override → parent step).
   * Omitted when no assignee can be resolved from persisted runtime records.
   */
  assigneeType?: string;
  assigneeId?: string;
};

export type WorkflowStepTrackerHttpDto = {
  stepId: string;
  name: string;
  instructions?: string;
  stepStatus: string;
  sortOrder: number;
  requirement?: string;
  allowSkip?: boolean;
  allowDefer?: boolean;
  /** Present when the runtime step was seeded from template defaultAssignee or later assigned. */
  assigneeType?: string;
  assigneeId?: string;
  linkedAction?: { actionCode: string };
  checklists: WorkflowWorkbenchChecklistHttpDto[];
};

function resolveWorkbenchChecklistAssigneeFields(
  record: WorkflowChecklistDdbRecord,
  step: WorkflowStepView,
): Pick<WorkflowWorkbenchChecklistHttpDto, 'assigneeType' | 'assigneeId'> {
  const effective = checklistAssignment.resolveEffectiveAssignee({
    checklist: record,
    // Assignment service only reads step assigneeType/assigneeId from persisted step.
    step: step as WorkflowStepDdbRecord,
  });
  if (effective.source === 'none' || !effective.assigneeId.trim()) {
    return {};
  }
  return {
    assigneeType: effective.assigneeType,
    assigneeId: effective.assigneeId,
  };
}

export function toWorkbenchChecklistDto(
  record: WorkflowChecklistDdbRecord,
  step?: WorkflowStepView,
): WorkflowWorkbenchChecklistHttpDto {
  const view = toWorkflowChecklistView(record);
  return {
    checklistId: view.checklistId,
    itemName: view.itemName,
    ...(view.instruction !== undefined ? { instruction: view.instruction } : {}),
    required: view.required,
    allowSkip: view.allowSkip,
    allowDefer: view.allowDefer,
    ...(view.blocksStepCompletion !== undefined
      ? { blocksStepCompletion: view.blocksStepCompletion }
      : {}),
    ...(view.linkedAction !== undefined ? { linkedAction: view.linkedAction } : {}),
    checklistStatus: view.checklistStatus,
    recordVersion: view.recordVersion,
    ...(view.reason !== undefined ? { reason: view.reason } : {}),
    sortOrder: view.sortOrder,
    ...(step !== undefined ? resolveWorkbenchChecklistAssigneeFields(record, step) : {}),
  };
}

function groupChecklistsByStepId(
  checklists: WorkflowChecklistDdbRecord[],
  stepById: Map<string, WorkflowStepView>,
): Map<string, WorkflowWorkbenchChecklistHttpDto[]> {
  const byStep = new Map<string, WorkflowWorkbenchChecklistHttpDto[]>();
  for (const record of checklists) {
    const step = stepById.get(record.stepId);
    const dto = toWorkbenchChecklistDto(record, step);
    const existing = byStep.get(record.stepId);
    if (existing) {
      existing.push(dto);
    } else {
      byStep.set(record.stepId, [dto]);
    }
  }
  for (const items of byStep.values()) {
    items.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.checklistId.localeCompare(b.checklistId),
    );
  }
  return byStep;
}

export function toStepTrackerDto(
  steps: WorkflowStepView[],
  checklists: WorkflowChecklistDdbRecord[] = [],
  workflowDisplayAssignee?: WorkflowAssigneeDisplayRef,
): WorkflowStepTrackerHttpDto[] {
  const stepById = new Map(steps.map((step) => [step.stepId, step]));
  const checklistsByStep = groupChecklistsByStepId(checklists, stepById);
  return steps.map((s) => {
    const displayAssignee = resolveStepDisplayAssignee(s, workflowDisplayAssignee);
    return {
      stepId: s.stepId,
      name: s.name,
      ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      stepStatus: s.stepStatus,
      sortOrder: s.sortOrder,
      requirement: s.requirement,
      allowSkip: s.allowSkip,
      allowDefer: s.allowDefer,
      ...(displayAssignee
        ? {
            assigneeType: displayAssignee.assigneeType,
            assigneeId: displayAssignee.assigneeId,
          }
        : {}),
      ...(s.linkedAction !== undefined ? { linkedAction: s.linkedAction } : {}),
      checklists: checklistsByStep.get(s.stepId) ?? [],
    };
  });
}
