import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateWaitWorkflowRequest,
  type ValidatedWaitWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { reasonWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

/**
 * Wait for a workflow to complete.
 * @param ctrl - The controller instance.
 * @param req - The request body.
 * @returns The response body.
 */
export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.wait',
  bodySchema: reasonWorkflowHttpBodySchema,
  validator: validateWaitWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleWait(req as ValidatedWaitWorkflowRequest),
});

export default main;
