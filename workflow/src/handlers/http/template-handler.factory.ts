import {
  withApiHandler,
  type MiddlewarePipelineEvent,
} from '@api-hub/middleware';
import type { LambdaRequest } from '@api-hub/utils';
import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ZodTypeAny } from 'zod';

import { getCarePlanWorkflowMappingHttpController } from '../../controllers/care-plan-workflow-mapping-http.controller';
import { getWorkflowTemplateHttpController } from '../../controllers/workflow-template-http.controller';
import { withWorkflowTemplateBodyValidation } from '../../utils/workflow-template-validation-http-error';

type HandlerOptions = {
  operation: string;
  bodySchema?: ZodTypeAny;
  validator: (req: LambdaRequest) => void | Promise<void>;
  handle: (req: LambdaRequest) => Promise<unknown>;
};

type TemplateHttpLambda = (
  event: MiddlewarePipelineEvent,
  context?: unknown,
) => Promise<APIGatewayProxyResult>;

function buildHandler(options: HandlerOptions): TemplateHttpLambda {
  return withApiHandler<MiddlewarePipelineEvent, APIGatewayProxyResult>(
    {
      operation: options.operation,
      validator: withWorkflowTemplateBodyValidation(
        options.bodySchema,
        options.validator,
      ),
      useLegacyResponseFormat: true,
    },
    options.handle as never,
  );
}

export function createTemplateHttpHandler(options: {
  operation: string;
  bodySchema?: ZodTypeAny;
  validator: (req: LambdaRequest) => void | Promise<void>;
  method:
    | 'handleCreate'
    | 'handleUpdate'
    | 'handlePublish'
    | 'handleInactivate'
    | 'handleClone'
    | 'handleGet'
    | 'handleListHistory'
    | 'handleList'
    | 'handleEnsureFromPlatform'
    | 'handleCloneOrgTemplatesForCarePlan'
    | 'handlePublishMappedOrgTemplates';
}) {
  return buildHandler({
    operation: options.operation,
    bodySchema: options.bodySchema,
    validator: options.validator,
    handle: (req) =>
      getWorkflowTemplateHttpController()[options.method](req as never),
  });
}

export function createCarePlanMappingHttpHandler(options: {
  operation: string;
  bodySchema?: ZodTypeAny;
  validator: (req: LambdaRequest) => void | Promise<void>;
  method: 'handleGet' | 'handlePut' | 'handleDelete';
}) {
  return buildHandler({
    operation: options.operation,
    bodySchema: options.bodySchema,
    validator: options.validator,
    handle: (req) =>
      getCarePlanWorkflowMappingHttpController()[options.method](req as never),
  });
}
