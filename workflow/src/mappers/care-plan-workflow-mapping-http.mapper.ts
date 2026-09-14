import type { CarePlanWorkflowMappingDdbRecord } from '@api-hub/workflow-runtime-core';

export type CarePlanWorkflowMappingHttpDto = {
  organizationId: string;
  carePlanTemplateId: string;
  workflowStage: string;
  workflowTemplateId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  recordVersion: number;
};

export type CarePlanWorkflowMappingsHttpDto = {
  organizationId: string;
  carePlanTemplateId: string;
  mappings: CarePlanWorkflowMappingHttpDto[];
};

export function toCarePlanMappingHttpDto(
  record: CarePlanWorkflowMappingDdbRecord,
): CarePlanWorkflowMappingHttpDto {
  return {
    organizationId: record.organizationId,
    carePlanTemplateId: record.carePlanTemplateId,
    workflowStage: record.workflowStage,
    workflowTemplateId: record.workflowTemplateId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    ...(record.updatedBy !== undefined ? { updatedBy: record.updatedBy } : {}),
    recordVersion: record.recordVersion,
  };
}

export function toCarePlanMappingsHttpDto(input: {
  organizationId: string;
  carePlanTemplateId: string;
  mappings: CarePlanWorkflowMappingDdbRecord[];
}): CarePlanWorkflowMappingsHttpDto {
  return {
    organizationId: input.organizationId,
    carePlanTemplateId: input.carePlanTemplateId,
    mappings: input.mappings.map(toCarePlanMappingHttpDto),
  };
}
