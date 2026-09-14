import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateCompleteWorkflowRequest,
  type ValidatedCompleteWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { completeWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.complete',
  bodySchema: completeWorkflowHttpBodySchema,
  validator: validateCompleteWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleComplete(req as ValidatedCompleteWorkflowRequest),
});

export default main;
