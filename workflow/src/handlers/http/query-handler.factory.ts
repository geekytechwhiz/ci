/**
 * Shared factory for thin WR-08c runtime query HTTP handlers.
 */
import { withApiHandler, type withApiHandlerOptions } from '@api-hub/middleware';
import type { LambdaRequest } from '@api-hub/utils';

import { getWorkflowQueryHttpController } from '../../controllers/workflow-query-http.controller';

export function createRuntimeQueryHandler(input: {
  operation: string;
  validator: (req: LambdaRequest) => void | Promise<void>;
  handle: (
    ctrl: ReturnType<typeof getWorkflowQueryHttpController>,
    req: LambdaRequest,
  ) => Promise<unknown>;
}) {
  const options: withApiHandlerOptions = {
    operation: input.operation,
    validator: input.validator,
    useLegacyResponseFormat: true,
  };

  return withApiHandler(options, async (req) =>
    input.handle(getWorkflowQueryHttpController(), req),
  );
}
