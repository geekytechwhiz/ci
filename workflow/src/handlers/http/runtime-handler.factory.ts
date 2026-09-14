/**
 * Shared factory for thin WR-08b runtime command HTTP handlers.
 */
import { withApiHandler, type withApiHandlerOptions } from '@api-hub/middleware';
import type { LambdaRequest } from '@api-hub/utils';
import type { z } from 'zod';

import { getWorkflowRuntimeHttpController } from '../../controllers/workflow-runtime-http.controller';

export function createRuntimeCommandHandler(input: {
  operation: string;
  bodySchema?: z.ZodType<unknown>;
  validator: (req: LambdaRequest) => void | Promise<void>;
  handle: (
    ctrl: ReturnType<typeof getWorkflowRuntimeHttpController>,
    req: LambdaRequest,
  ) => Promise<unknown>;
}) {
  const options: withApiHandlerOptions = {
    operation: input.operation,
    ...(input.bodySchema ? { bodySchema: input.bodySchema } : {}),
    validator: input.validator,
    useLegacyResponseFormat: true,
  };

  return withApiHandler(options, async (req) =>
    input.handle(getWorkflowRuntimeHttpController(), req),
  );
}
