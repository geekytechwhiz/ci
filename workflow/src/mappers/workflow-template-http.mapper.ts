import type {
  WorkflowTemplateAggregate,
  WorkflowTemplateMetadataDdbRecord,
} from '@api-hub/workflow-runtime-core';
import {
  nestTemplateSteps,
  TEMPLATE_SCOPE,
} from '@api-hub/workflow-runtime-core';

export type WorkflowTemplateChecklistHttpDto = {
  checklistId: string;
  itemName: string;
  instruction?: string;
  required: boolean;
  allowSkip: boolean;
  allowDefer: boolean;
  blocksStepCompletion?: boolean;
  linkedAction?: { actionCode: string };
  linkedObject?: { objectType: string; objectId: string };
  assigneeOverride?: { assigneeType: string; assigneeId: string };
  active: boolean;
  sortOrder: number;
};

export type WorkflowTemplateStepHttpDto = {
  stepId: string;
  name: string;
  instructions?: string;
  requirement: string;
  allowSkip: boolean;
  allowDefer: boolean;
  condition: string | null;
  sortOrder: number;
  defaultAssignee?: { assigneeType: string; assigneeId: string };
  linkedAction?: { actionCode: string };
  checklists: WorkflowTemplateChecklistHttpDto[];
};

export type WorkflowTemplateHttpDto = {
  scope: string;
  organizationId?: string;
  templateId: string;
  /** Same as `templateId` when scope is organization. Use this id for Org Admin GET/PUT/publish. */
  orgTemplateId?: string;
  templateName: string;
  workflowType: string;
  workflowStage: string;
  status: string;
  version: number;
  description?: string;
  program?: string;
  condition?: string;
  basedOn?: string;
  /** Metadata Registry value codes; labels are resolved by the caller. */
  category?: string;
  shareScope?: string;
  language?: string;
  country?: string;
  platformTemplateId?: string;
  defaultAssignee?: { assigneeType: string; assigneeId: string };
  stepCount: number;
  checklistItemCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  /** Display name for `createdBy` when resolved from USER_TABLE (list/GET enrichment). */
  createdByName?: string;
  /** Display name for `updatedBy` when resolved from USER_TABLE (list/GET enrichment). */
  updatedByName?: string;
  recordVersion: number;
  steps: WorkflowTemplateStepHttpDto[];
};

export type WorkflowTemplateSummaryHttpDto = Omit<
  WorkflowTemplateHttpDto,
  'steps'
>;

function toChecklistDto(item: {
  checklistId: string;
  itemName: string;
  instruction?: string;
  required: boolean;
  allowSkip: boolean;
  allowDefer: boolean;
  blocksStepCompletion?: boolean;
  linkedAction?: { actionCode: string };
  linkedObject?: { objectType: string; objectId: string };
  assigneeOverride?: { assigneeType: string; assigneeId: string };
  active: boolean;
  sortOrder: number;
}): WorkflowTemplateChecklistHttpDto {
  return {
    checklistId: item.checklistId,
    itemName: item.itemName,
    ...(item.instruction !== undefined ? { instruction: item.instruction } : {}),
    required: item.required,
    allowSkip: item.allowSkip,
    allowDefer: item.allowDefer,
    ...(item.blocksStepCompletion !== undefined
      ? { blocksStepCompletion: item.blocksStepCompletion }
      : {}),
    ...(item.linkedAction ? { linkedAction: item.linkedAction } : {}),
    ...(item.linkedObject ? { linkedObject: item.linkedObject } : {}),
    ...(item.assigneeOverride
      ? { assigneeOverride: item.assigneeOverride }
      : {}),
    active: item.active,
    sortOrder: item.sortOrder,
  };
}

function toSummaryDto(
  metadata: WorkflowTemplateMetadataDdbRecord,
): WorkflowTemplateSummaryHttpDto {
  return {
    scope: metadata.scope,
    ...(metadata.scope === TEMPLATE_SCOPE.ORGANIZATION
      ? {
          organizationId: metadata.organizationId,
          orgTemplateId: metadata.templateId,
        }
      : {}),
    templateId: metadata.templateId,
    templateName: metadata.templateName,
    workflowType: metadata.workflowType,
    workflowStage: metadata.workflowStage,
    status: metadata.status,
    version: metadata.version,
    ...(metadata.description !== undefined
      ? { description: metadata.description }
      : {}),
    ...(metadata.program !== undefined ? { program: metadata.program } : {}),
    ...(metadata.condition !== undefined
      ? { condition: metadata.condition }
      : {}),
    ...(metadata.basedOn !== undefined ? { basedOn: metadata.basedOn } : {}),
    ...(metadata.category !== undefined ? { category: metadata.category } : {}),
    ...(metadata.shareScope !== undefined
      ? { shareScope: metadata.shareScope }
      : {}),
    ...(metadata.language !== undefined ? { language: metadata.language } : {}),
    ...(metadata.country !== undefined ? { country: metadata.country } : {}),
    ...('platformTemplateId' in metadata && metadata.platformTemplateId
      ? { platformTemplateId: metadata.platformTemplateId }
      : {}),
    ...(metadata.defaultAssignee
      ? { defaultAssignee: metadata.defaultAssignee }
      : {}),
    stepCount: metadata.stepCount,
    checklistItemCount: metadata.checklistItemCount,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.createdBy !== undefined
      ? { createdBy: metadata.createdBy }
      : {}),
    ...(metadata.updatedBy !== undefined
      ? { updatedBy: metadata.updatedBy }
      : {}),
    recordVersion: metadata.recordVersion,
  };
}

export function toTemplateHttpDto(
  aggregate: WorkflowTemplateAggregate,
): WorkflowTemplateHttpDto {
  const nested = nestTemplateSteps(aggregate);
  return {
    ...toSummaryDto(aggregate.metadata),
    steps: nested.map(({ step, checklists }) => ({
      stepId: step.stepId,
      name: step.name,
      ...(step.instructions !== undefined
        ? { instructions: step.instructions }
        : {}),
      requirement: step.requirement,
      allowSkip: step.allowSkip,
      allowDefer: step.allowDefer,
      condition: step.condition ?? null,
      sortOrder: step.sortOrder,
      ...(step.defaultAssignee
        ? { defaultAssignee: step.defaultAssignee }
        : {}),
      ...(step.linkedAction ? { linkedAction: step.linkedAction } : {}),
      checklists: checklists.map(toChecklistDto),
    })),
  };
}

export function toTemplateSummaryHttpDto(
  metadata: WorkflowTemplateMetadataDdbRecord,
): WorkflowTemplateSummaryHttpDto {
  return toSummaryDto(metadata);
}

export function toTemplateHttpDtoFromMetadataOnly(
  metadata: WorkflowTemplateMetadataDdbRecord,
): WorkflowTemplateHttpDto {
  return {
    ...toSummaryDto(metadata),
    steps: [],
  };
}

export type WorkflowTemplateHistoryHttpDto = {
  historyId: string;
  templateId: string;
  scope: string;
  organizationId?: string;
  action: string;
  actorId?: string;
  actorType?: string;
  timestamp: string;
  reason?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export function toTemplateHistoryHttpDto(record: {
  historyId: string;
  templateId: string;
  scope: string;
  organizationId?: string;
  action: string;
  actorId?: string;
  actorType?: string;
  timestamp: string;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}): WorkflowTemplateHistoryHttpDto {
  return {
    historyId: record.historyId,
    templateId: record.templateId,
    scope: record.scope,
    ...(record.organizationId !== undefined
      ? { organizationId: record.organizationId }
      : {}),
    action: record.action,
    ...(record.actorId !== undefined ? { actorId: record.actorId } : {}),
    ...(record.actorType !== undefined ? { actorType: record.actorType } : {}),
    timestamp: record.timestamp,
    reason: record.reason ?? null,
    ...(record.before !== undefined ? { before: record.before } : {}),
    ...(record.after !== undefined ? { after: record.after } : {}),
  };
}
