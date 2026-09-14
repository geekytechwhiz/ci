import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStartWorkflowRequest,
  type ValidatedStartWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { optionalOccBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.start',
  bodySchema: optionalOccBodySchema,
  validator: validateStartWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleStart(req as ValidatedStartWorkflowRequest),
});

export default main;
