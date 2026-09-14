import type {
  ChecklistQueryResult,
  WorkflowChecklistView,
  WorkflowInstanceView,
  WorkflowStepView,
} from '@api-hub/workflow-runtime-core';

/** REST workflow instance (no pk/sk/GSI/TTL/entityType). */
export type WorkflowInstanceHttpDto = {
  organizationId: string;
  workflowId: string;
  workflowType: string;
  definitionVersion: string;
  patientId: string;
  carePlanId: string;
  contextKey: string;
  workflowStatus: string;
  dueAt?: string;
  priority?: number;
  assigneeType?: string;
  assigneeId?: string;
  completionSummary?: string;
  outcome?: string;
  correlationId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  recordVersion: number;
};

export type WorkflowStepHttpDto = {
  organizationId: string;
  workflowId: string;
  stepId: string;
  name: string;
  instructions?: string;
  stepStatus: string;
  sortOrder: number;
  requirement?: string;
  allowSkip?: boolean;
  allowDefer?: boolean;
  condition?: string | null;
  assigneeType?: string;
  assigneeId?: string;
  reason?: string;
  linkedAction?: { actionCode: string };
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  recordVersion: number;
};

export type WorkflowChecklistHttpDto = {
  organizationId: string;
  workflowId: string;
  stepId: string;
  checklistId: string;
  itemName: string;
  instruction?: string;
  required: boolean;
  allowSkip: boolean;
  allowDefer: boolean;
  blocksStepCompletion?: boolean;
  linkedAction?: { actionCode: string };
  linkedObject?: { objectType: string; objectId: string };
  checklistStatus: string;
  active: boolean;
  sortOrder: number;
  assigneeType?: string;
  assigneeId?: string;
  assigneeOverride?: { assigneeType: string; assigneeId: string };
  reason?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  recordVersion: number;
  effectiveAssignee?: {
    assigneeType: string;
    assigneeId: string;
    source: string;
  };
};

export function toWorkflowChecklistHttpDto(
  view: WorkflowChecklistView | ChecklistQueryResult,
): WorkflowChecklistHttpDto {
  const dto: WorkflowChecklistHttpDto = {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    stepId: view.stepId,
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
    ...(view.linkedObject !== undefined ? { linkedObject: view.linkedObject } : {}),
    checklistStatus: view.checklistStatus,
    active: view.active,
    sortOrder: view.sortOrder,
    ...(view.assigneeType !== undefined ? { assigneeType: view.assigneeType } : {}),
    ...(view.assigneeId !== undefined ? { assigneeId: view.assigneeId } : {}),
    ...(view.assigneeOverride !== undefined
      ? { assigneeOverride: view.assigneeOverride }
      : {}),
    ...(view.reason !== undefined ? { reason: view.reason } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.updatedBy !== undefined ? { updatedBy: view.updatedBy } : {}),
    recordVersion: view.recordVersion,
  };
  if ('effectiveAssignee' in view && view.effectiveAssignee) {
    dto.effectiveAssignee = {
      assigneeType: view.effectiveAssignee.assigneeType,
      assigneeId: view.effectiveAssignee.assigneeId,
      source: view.effectiveAssignee.source,
    };
  }
  return dto;
}

export function toWorkflowInstanceHttpDto(
  view: WorkflowInstanceView,
): WorkflowInstanceHttpDto {
  return {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    workflowType: view.workflowType,
    definitionVersion: view.definitionVersion,
    patientId: view.patientId,
    carePlanId: view.carePlanId,
    contextKey: view.contextKey,
    workflowStatus: view.workflowStatus,
    ...(view.dueAt !== undefined ? { dueAt: view.dueAt } : {}),
    ...(view.priority !== undefined ? { priority: view.priority } : {}),
    ...(view.assigneeType !== undefined ? { assigneeType: view.assigneeType } : {}),
    ...(view.assigneeId !== undefined ? { assigneeId: view.assigneeId } : {}),
    ...(view.completionSummary !== undefined
      ? { completionSummary: view.completionSummary }
      : {}),
    ...(view.outcome !== undefined ? { outcome: view.outcome } : {}),
    ...(view.correlationId !== undefined ? { correlationId: view.correlationId } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.createdBy !== undefined ? { createdBy: view.createdBy } : {}),
    ...(view.updatedBy !== undefined ? { updatedBy: view.updatedBy } : {}),
    recordVersion: view.recordVersion,
  };
}

export function toWorkflowStepHttpDto(view: WorkflowStepView): WorkflowStepHttpDto {
  return {
    organizationId: view.organizationId,
    workflowId: view.workflowId,
    stepId: view.stepId,
    name: view.name,
    ...(view.instructions !== undefined ? { instructions: view.instructions } : {}),
    stepStatus: view.stepStatus,
    sortOrder: view.sortOrder,
    ...(view.requirement !== undefined ? { requirement: view.requirement } : {}),
    ...(view.allowSkip !== undefined ? { allowSkip: view.allowSkip } : {}),
    ...(view.allowDefer !== undefined ? { allowDefer: view.allowDefer } : {}),
    ...(view.condition !== undefined ? { condition: view.condition } : {}),
    ...(view.assigneeType !== undefined ? { assigneeType: view.assigneeType } : {}),
    ...(view.assigneeId !== undefined ? { assigneeId: view.assigneeId } : {}),
    ...(view.reason !== undefined ? { reason: view.reason } : {}),
    ...(view.linkedAction !== undefined ? { linkedAction: view.linkedAction } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...(view.updatedBy !== undefined ? { updatedBy: view.updatedBy } : {}),
    recordVersion: view.recordVersion,
  };
}
