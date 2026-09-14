import { z } from 'zod';
import { CATALOG_VALUE_CODE_PATTERN } from '@api-hub/utils';
import {
  ASSIGNEE_TYPE,
  MAX_WORKFLOW_TEMPLATE_STEPS,
  STEP_REQUIREMENT,
  TEMPLATE_STATUS,
  WORKFLOW_STAGE,
  WORKFLOW_TYPE,
} from '@api-hub/workflow-runtime-core';

const nonEmptyString = z.string().trim().min(1);

const assigneeSchema = z
  .object({
    assigneeType: z.enum([
      ASSIGNEE_TYPE.USER,
      ASSIGNEE_TYPE.ROLE,
      ASSIGNEE_TYPE.TEAM,
    ]),
    assigneeId: nonEmptyString,
  })
  .strict();

const linkedActionSchema = z
  .object({
    actionCode: nonEmptyString,
  })
  .strict();

const linkedObjectSchema = z
  .object({
    objectType: nonEmptyString,
    objectId: nonEmptyString,
  })
  .strict();

const CHECKLIST_ITEM_ID_MESSAGE = 'Please provide a checklist item ID.';
const CHECKLIST_ITEM_NAME_MESSAGE = 'Please enter a checklist item.';
const CHECKLIST_ITEM_INCOMPLETE_MESSAGE =
  'Please complete the checklist item before saving the workflow.';

const templateChecklistSchema = z
  .object({
    checklistId: z.string().trim().min(1, CHECKLIST_ITEM_ID_MESSAGE),
    itemName: z.string().trim().min(1, CHECKLIST_ITEM_NAME_MESSAGE),
    instruction: z.string().optional(),
    required: z.boolean(),
    allowSkip: z.boolean(),
    allowDefer: z.boolean(),
    blocksStepCompletion: z.boolean().optional(),
    linkedAction: linkedActionSchema.optional(),
    linkedObject: linkedObjectSchema.optional(),
    assigneeOverride: assigneeSchema.optional(),
    active: z.boolean(),
    sortOrder: z.number().finite(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (!item.checklistId?.trim() && !item.itemName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: CHECKLIST_ITEM_INCOMPLETE_MESSAGE,
      });
    }
  });

const templateStepSchema = z
  .object({
    stepId: nonEmptyString,
    name: nonEmptyString,
    instructions: z.string().optional(),
    requirement: z.enum([
      STEP_REQUIREMENT.MANDATORY,
      STEP_REQUIREMENT.OPTIONAL,
      STEP_REQUIREMENT.CONDITIONAL,
    ]),
    allowSkip: z.boolean(),
    allowDefer: z.boolean(),
    condition: z.string().nullable().optional(),
    sortOrder: z.number().finite(),
    defaultAssignee: assigneeSchema.optional(),
    linkedAction: linkedActionSchema.optional(),
    checklists: z.array(templateChecklistSchema).optional(),
  })
  .strict();

const workflowStageSchema = z.enum([
  WORKFLOW_STAGE.PATIENT_ONBOARDING,
  WORKFLOW_STAGE.FORMAL_REVIEW,
  WORKFLOW_STAGE.CLOSURE_REVIEW,
]);

const workflowTypeSchema = z.enum([
  WORKFLOW_TYPE.PATIENT_ONBOARDING,
  WORKFLOW_TYPE.FORMAL_REVIEW,
  WORKFLOW_TYPE.CLOSURE_REVIEW,
]);

function assertNoDuplicateStepIds(
  steps: { stepId: string }[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (seen.has(step.stepId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps', index, 'stepId'],
        message: `Duplicate stepId: ${step.stepId}`,
      });
    }
    seen.add(step.stepId);
  }
}

function assertNoDuplicateChecklistIds(
  steps: { stepId: string; checklists?: { checklistId: string }[] }[],
  ctx: z.RefinementCtx,
): void {
  for (const [stepIndex, step] of steps.entries()) {
    const checklists = step.checklists ?? [];
    const seen = new Set<string>();
    for (const [index, item] of checklists.entries()) {
      if (seen.has(item.checklistId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', stepIndex, 'checklists', index, 'checklistId'],
          message: `Duplicate checklistId: ${item.checklistId}`,
        });
      }
      seen.add(item.checklistId);
    }
  }
}

function refineTemplateSteps(
  steps: {
    stepId: string;
    checklists?: { checklistId: string }[];
  }[],
  ctx: z.RefinementCtx,
): void {
  assertNoDuplicateStepIds(steps, ctx);
  assertNoDuplicateChecklistIds(steps, ctx);
}

/**
 * Catalog metadata selected from the Metadata Registry. The API accepts the
 * `metadataValueCode` only — dropdown options and labels come from
 * `POST /metadata/values/by-types`, so nothing here duplicates the catalog.
 */
const metadataValueCodeSchema = z
  .string()
  .trim()
  .regex(
    CATALOG_VALUE_CODE_PATTERN,
    'Must be a metadata value code (e.g. CHRONIC)',
  );

const catalogMetadataShape = {
  category: metadataValueCodeSchema.optional(),
  shareScope: metadataValueCodeSchema.optional(),
  language: metadataValueCodeSchema.optional(),
  country: metadataValueCodeSchema.optional(),
};

export const createWorkflowTemplateHttpBodySchema = z
  .object({
    templateId: nonEmptyString.optional(),
    templateName: nonEmptyString,
    workflowType: workflowTypeSchema,
    workflowStage: workflowStageSchema,
    description: z.string().optional(),
    program: z.string().optional(),
    condition: z.string().optional(),
    basedOn: z.string().optional(),
    ...catalogMetadataShape,
    platformTemplateId: nonEmptyString.optional(),
    defaultAssignee: assigneeSchema.optional(),
    steps: z.array(templateStepSchema),
  })
  .strict()
  .superRefine((body, ctx) => {
    refineTemplateSteps(body.steps, ctx);
  });

export const updateWorkflowTemplateHttpBodySchema = z
  .object({
    templateName: nonEmptyString,
    description: z.string().optional(),
    program: z.string().optional(),
    condition: z.string().optional(),
    basedOn: z.string().optional(),
    ...catalogMetadataShape,
    platformTemplateId: nonEmptyString.optional(),
    defaultAssignee: assigneeSchema.optional(),
    recordVersion: z.number().int().positive().optional(),
    steps: z.array(templateStepSchema),
  })
  .strict()
  .superRefine((body, ctx) => {
    refineTemplateSteps(body.steps, ctx);
  });

const optionalRecordVersionBody = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      recordVersion: z.number().int().positive().optional(),
    })
    .strict(),
);

export const publishWorkflowTemplateHttpBodySchema = optionalRecordVersionBody;
export const inactivateWorkflowTemplateHttpBodySchema = optionalRecordVersionBody;

export const cloneWorkflowTemplateHttpBodySchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      templateId: nonEmptyString.optional(),
      templateName: nonEmptyString.optional(),
      description: z.string().optional(),
      program: z.string().optional(),
      condition: z.string().optional(),
      basedOn: z.string().optional(),
      ...catalogMetadataShape,
      platformTemplateId: nonEmptyString.optional(),
      defaultAssignee: assigneeSchema.optional(),
      steps: z.array(templateStepSchema).optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.steps) {
        refineTemplateSteps(body.steps, ctx);
      }
    }),
);

export const templateStatusQuerySchema = z.enum([
  TEMPLATE_STATUS.DRAFT,
  TEMPLATE_STATUS.PUBLISHED,
  TEMPLATE_STATUS.INACTIVE,
]);

export const putCarePlanWorkflowMappingsHttpBodySchema = z
  .object({
    mappings: z
      .array(
        z
          .object({
            workflowStage: workflowStageSchema,
            workflowTemplateId: nonEmptyString,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    for (const [index, mapping] of body.mappings.entries()) {
      if (seen.has(mapping.workflowStage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mappings', index, 'workflowStage'],
          message: `Duplicate workflowStage: ${mapping.workflowStage}`,
        });
      }
      seen.add(mapping.workflowStage);
    }
  });

/** S2S: clone Org Template workflows into Care Plan–scoped drafts. */
export const cloneOrgWorkflowTemplatesForCarePlanHttpBodySchema = z
  .object({
    carePlanTemplateId: nonEmptyString,
    mappings: z
      .array(
        z
          .object({
            workflowStage: workflowStageSchema,
            workflowTemplateId: nonEmptyString,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    for (const [index, mapping] of body.mappings.entries()) {
      if (seen.has(mapping.workflowStage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mappings', index, 'workflowStage'],
          message: `Duplicate workflowStage: ${mapping.workflowStage}`,
        });
      }
      seen.add(mapping.workflowStage);
    }
  });

/** S2S: publish Org Template mapped org workflow ids (idempotent; org-scoped only). */
export const publishMappedOrgWorkflowTemplatesHttpBodySchema = z
  .object({
    workflowTemplateIds: z.array(nonEmptyString).min(1),
  })
  .strict();

export const deleteCarePlanWorkflowMappingHttpBodySchema = optionalRecordVersionBody;

export { MAX_WORKFLOW_TEMPLATE_STEPS, workflowStageSchema, workflowTypeSchema };

export type CreateWorkflowTemplateHttpBody = z.infer<
  typeof createWorkflowTemplateHttpBodySchema
>;
export type UpdateWorkflowTemplateHttpBody = z.infer<
  typeof updateWorkflowTemplateHttpBodySchema
>;
export type PublishWorkflowTemplateHttpBody = z.infer<
  typeof publishWorkflowTemplateHttpBodySchema
>;
export type InactivateWorkflowTemplateHttpBody = z.infer<
  typeof inactivateWorkflowTemplateHttpBodySchema
>;
export type CloneWorkflowTemplateHttpBody = z.infer<
  typeof cloneWorkflowTemplateHttpBodySchema
>;
export type PutCarePlanWorkflowMappingsHttpBody = z.infer<
  typeof putCarePlanWorkflowMappingsHttpBodySchema
>;
export type CloneOrgWorkflowTemplatesForCarePlanHttpBody = z.infer<
  typeof cloneOrgWorkflowTemplatesForCarePlanHttpBodySchema
>;
export type PublishMappedOrgWorkflowTemplatesHttpBody = z.infer<
  typeof publishMappedOrgWorkflowTemplatesHttpBodySchema
>;
export type DeleteCarePlanWorkflowMappingHttpBody = z.infer<
  typeof deleteCarePlanWorkflowMappingHttpBodySchema
>;
