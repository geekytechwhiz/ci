import { withApiHandler, type MiddlewarePipelineEvent } from '@api-hub/middleware';
import type { LambdaRequest } from '@api-hub/utils';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';

import { getCarePlanCreationSessionHttpController } from '../../controllers/care-plan-creation-session-http.controller';
import {
  validateDiscardCarePlanCreationSessionRequest,
  validateFinalizeCarePlanCreationSessionRequest,
  validateGetCarePlanCreationSessionRequest,
  validatePublishCarePlanCreationSessionWorkflowsRequest,
  validateReserveCarePlanCreationSessionRequest,
  validateStartCarePlanCreationSessionRequest,
} from '../../validators/care-plan-creation-session.validators';
import {
  finalizeCarePlanCreationSessionHttpBodySchema,
  publishCarePlanCreationSessionWorkflowsHttpBodySchema,
  reserveCarePlanCreationSessionHttpBodySchema,
  startCarePlanCreationSessionHttpBodySchema,
} from '../../validators/care-plan-creation-session.schemas';

function build(
  operation: string,
  bodySchema: z.ZodTypeAny | undefined,
  validator: (req: LambdaRequest) => void | Promise<void>,
  handle: (req: LambdaRequest) => Promise<unknown>,
) {
  return withApiHandler<MiddlewarePipelineEvent, APIGatewayProxyResult>(
    {
      operation,
      bodySchema,
      validator,
      useLegacyResponseFormat: true,
    },
    handle as never,
  );
}

export const startMain = build(
  'workflow.carePlanCreationSession.start',
  startCarePlanCreationSessionHttpBodySchema,
  validateStartCarePlanCreationSessionRequest,
  (req) => getCarePlanCreationSessionHttpController().handleStart(req as never),
);

export const getMain = build(
  'workflow.carePlanCreationSession.get',
  undefined,
  validateGetCarePlanCreationSessionRequest,
  (req) => getCarePlanCreationSessionHttpController().handleGet(req as never),
);

export const discardMain = build(
  'workflow.carePlanCreationSession.discard',
  undefined,
  validateDiscardCarePlanCreationSessionRequest,
  (req) => getCarePlanCreationSessionHttpController().handleDiscard(req as never),
);

export const finalizeMain = build(
  'workflow.carePlanCreationSession.finalize',
  finalizeCarePlanCreationSessionHttpBodySchema,
  validateFinalizeCarePlanCreationSessionRequest,
  (req) =>
    getCarePlanCreationSessionHttpController().handleFinalize(req as never),
);

export const reserveCarePlanMain = build(
  'workflow.carePlanCreationSession.reserveCarePlan',
  reserveCarePlanCreationSessionHttpBodySchema,
  validateReserveCarePlanCreationSessionRequest,
  (req) =>
    getCarePlanCreationSessionHttpController().handleReserveCarePlan(
      req as never,
    ),
);

export const publishWorkflowsMain = build(
  'workflow.carePlanCreationSession.publishWorkflows',
  publishCarePlanCreationSessionWorkflowsHttpBodySchema,
  validatePublishCarePlanCreationSessionWorkflowsRequest,
  (req) =>
    getCarePlanCreationSessionHttpController().handlePublishWorkflows(
      req as never,
    ),
);
