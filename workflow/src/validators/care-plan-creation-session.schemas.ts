import { z } from 'zod';

import { workflowStageSchema } from './workflow-template.schemas';

const nonEmptyString = z.string().trim().min(1);

export const startCarePlanCreationSessionHttpBodySchema = z
  .object({
    sourceOrgTemplateId: nonEmptyString,
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
    clientRequestId: nonEmptyString.optional(),
  })
  .strict();

export const finalizeCarePlanCreationSessionHttpBodySchema = z
  .object({
    carePlanTemplateId: nonEmptyString,
  })
  .strict();

/** Reserve exactly one Care Plan catalog id on a pending session (before CP persist). */
export const reserveCarePlanCreationSessionHttpBodySchema = z
  .object({
    carePlanTemplateId: nonEmptyString,
  })
  .strict();

/** Attach Care Plan id (optional) then publish session drafts O1A… only. */
export const publishCarePlanCreationSessionWorkflowsHttpBodySchema = z
  .object({
    carePlanTemplateId: nonEmptyString.optional(),
  })
  .strict();

export type StartCarePlanCreationSessionHttpBody = z.infer<
  typeof startCarePlanCreationSessionHttpBodySchema
>;
export type FinalizeCarePlanCreationSessionHttpBody = z.infer<
  typeof finalizeCarePlanCreationSessionHttpBodySchema
>;
export type ReserveCarePlanCreationSessionHttpBody = z.infer<
  typeof reserveCarePlanCreationSessionHttpBodySchema
>;
export type PublishCarePlanCreationSessionWorkflowsHttpBody = z.infer<
  typeof publishCarePlanCreationSessionWorkflowsHttpBodySchema
>;
