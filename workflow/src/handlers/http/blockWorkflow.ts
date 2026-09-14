import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateBlockWorkflowRequest,
  type ValidatedBlockWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { reasonWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.block',
  bodySchema: reasonWorkflowHttpBodySchema,
  validator: validateBlockWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleBlock(req as ValidatedBlockWorkflowRequest),
});

export default main;
