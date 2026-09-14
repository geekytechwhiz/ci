import { z } from 'zod';
import {
  ASSIGNEE_TYPE,
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

/**
 * CarePlanWorkflowRequested.v1 domain payload (event-catalog.md).
 * Accepts EventBridge detail fields; `requestedAt` is an optional alias for `timestamp`.
 */
export const carePlanWorkflowRequestedPayloadSchema = z
  .object({
    eventId: nonEmptyString,
    eventType: z.enum(['CarePlanWorkflowRequested', 'CarePlanWorkflowRequested.v1']),
    eventVersion: z.union([z.literal(1), z.literal('1')]),
    timestamp: z.string().trim().min(1).optional(),
    requestedAt: z.string().trim().min(1).optional(),
    organizationId: nonEmptyString,
    patientId: nonEmptyString,
    carePlanId: nonEmptyString,
    workflowType: z.enum([
      WORKFLOW_TYPE.PATIENT_ONBOARDING,
      WORKFLOW_TYPE.FORMAL_REVIEW,
      WORKFLOW_TYPE.CLOSURE_REVIEW,
    ]),
    correlationId: nonEmptyString,
    contextKey: z.string().trim().min(1).optional(),
    /**
     * Org Care Plan catalog id (`orgTemplateId`) for mapping lookup.
     * Optional on inbound `.v1` so legacy events still parse; consumer then
     * falls back to CPR template-snapshot. Must not be `…-Vnn`.
     */
    carePlanTemplateId: nonEmptyString.optional(),
    /** Stage for mapping (defaults to workflowType when omitted). */
    workflowStage: workflowStageSchema.optional(),
    requestedBy: z.string().trim().min(1).optional(),
    assignee: assigneeSchema.optional(),
    dueAt: z.string().trim().min(1).optional(),
    autoStart: z.boolean().optional(),
    causationId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.timestamp && !value.requestedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timestamp or requestedAt is required',
        path: ['timestamp'],
      });
    }
  });

export type CarePlanWorkflowRequestedPayload = z.infer<
  typeof carePlanWorkflowRequestedPayloadSchema
>;
