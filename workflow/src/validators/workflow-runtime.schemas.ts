import { z } from 'zod';
import {
  ASSIGNEE_TYPE,
  STEP_REQUIREMENT,
  WORKFLOW_LIFECYCLE_OUTCOME,
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

const workflowStageSchema = z.enum([
  WORKFLOW_STAGE.PATIENT_ONBOARDING,
  WORKFLOW_STAGE.FORMAL_REVIEW,
  WORKFLOW_STAGE.CLOSURE_REVIEW,
]);

export const createWorkflowHttpBodySchema = z
  .object({
    workflowType: z.enum([
      WORKFLOW_TYPE.PATIENT_ONBOARDING,
      WORKFLOW_TYPE.FORMAL_REVIEW,
      WORKFLOW_TYPE.CLOSURE_REVIEW,
    ]),
    patientId: nonEmptyString,
    carePlanId: nonEmptyString,
    contextKey: z.string().trim().min(1).optional(),
    /** Care plan template that owns stage → workflowTemplateId mappings. */
    carePlanTemplateId: nonEmptyString,
    /** Stage for mapping lookup (defaults to workflowType when omitted). */
    workflowStage: workflowStageSchema.optional(),
    assignee: assigneeSchema.optional(),
    dueAt: z.string().trim().min(1).optional(),
    autoStart: z.boolean().optional(),
    correlationId: z.string().trim().min(1).optional(),
  })
  .strict();

export const assignWorkflowHttpBodySchema = z
  .object({
    assigneeType: z.enum([
      ASSIGNEE_TYPE.USER,
      ASSIGNEE_TYPE.ROLE,
      ASSIGNEE_TYPE.TEAM,
    ]),
    assigneeId: nonEmptyString,
    reason: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const reasonWorkflowHttpBodySchema = z
  .object({
    reason: nonEmptyString,
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const optionalOccBodySchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      recordVersion: z.number().int().positive().optional(),
      reason: z.string().optional(),
    })
    .strict(),
);

export const completeWorkflowHttpBodySchema = z
  .object({
    /** Lifecycle outcome for Care Plan Runtime — successful complete only. */
    outcome: z.literal(WORKFLOW_LIFECYCLE_OUTCOME.COMPLETED),
    finalNote: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const cancelWorkflowHttpBodySchema = z
  .object({
    reason: nonEmptyString,
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const stepActionHttpBodySchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      reason: z.string().optional(),
      note: z.string().optional(),
      recordVersion: z.number().int().positive().optional(),
    })
    .strict(),
);

export const stepActionWithReasonHttpBodySchema = z
  .object({
    reason: nonEmptyString,
    note: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const assignStepHttpBodySchema = z
  .object({
    assigneeType: z.enum([
      ASSIGNEE_TYPE.USER,
      ASSIGNEE_TYPE.ROLE,
      ASSIGNEE_TYPE.TEAM,
    ]),
    assigneeId: nonEmptyString,
    reason: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Patient-level structure customisation. Only whole steps / checklist items are
 * added or removed — `.strict()` keeps edits to an existing definition (rename,
 * instruction, requirement, assignee…) out of these routes.
 */
export const addWorkflowStepHttpBodySchema = z
  .object({
    stepId: nonEmptyString,
    name: nonEmptyString,
    requirement: z
      .enum([
        STEP_REQUIREMENT.MANDATORY,
        STEP_REQUIREMENT.OPTIONAL,
        STEP_REQUIREMENT.CONDITIONAL,
      ])
      .optional(),
    allowSkip: z.boolean().optional(),
    allowDefer: z.boolean().optional(),
    condition: z.string().nullable().optional(),
    assigneeType: z
      .enum([ASSIGNEE_TYPE.USER, ASSIGNEE_TYPE.ROLE, ASSIGNEE_TYPE.TEAM])
      .optional(),
    assigneeId: nonEmptyString.optional(),
    sortOrder: z.number().int().positive().optional(),
    reason: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

export const addStepChecklistHttpBodySchema = z
  .object({
    checklistId: nonEmptyString,
    itemName: nonEmptyString,
    instruction: z.string().optional(),
    required: z.boolean().optional(),
    allowSkip: z.boolean().optional(),
    allowDefer: z.boolean().optional(),
    blocksStepCompletion: z.boolean().optional(),
    sortOrder: z.number().int().positive().optional(),
    reason: z.string().optional(),
    recordVersion: z.number().int().positive().optional(),
  })
  .strict();

/** DELETE carries OCC in `If-Match`; an optional body may supply recordVersion. */
export const removeStructureHttpBodySchema = optionalOccBodySchema;

export type AddWorkflowStepHttpBody = z.infer<typeof addWorkflowStepHttpBodySchema>;
export type AddStepChecklistHttpBody = z.infer<
  typeof addStepChecklistHttpBodySchema
>;

export type CreateWorkflowHttpBody = z.infer<typeof createWorkflowHttpBodySchema>;
export type AssignWorkflowHttpBody = z.infer<typeof assignWorkflowHttpBodySchema>;
export type ReasonWorkflowHttpBody = z.infer<typeof reasonWorkflowHttpBodySchema>;
export type OptionalOccBody = z.infer<typeof optionalOccBodySchema>;
export type CompleteWorkflowHttpBody = z.infer<typeof completeWorkflowHttpBodySchema>;
export type CancelWorkflowHttpBody = z.infer<typeof cancelWorkflowHttpBodySchema>;
export type StepActionHttpBody = z.infer<typeof stepActionHttpBodySchema>;
export const assignChecklistHttpBodySchema = assignStepHttpBodySchema;

export const checklistActionHttpBodySchema = stepActionHttpBodySchema;
export const checklistActionWithReasonHttpBodySchema = stepActionWithReasonHttpBodySchema;

export type AssignChecklistHttpBody = z.infer<typeof assignChecklistHttpBodySchema>;
export type ChecklistActionHttpBody = z.infer<typeof checklistActionHttpBodySchema>;
