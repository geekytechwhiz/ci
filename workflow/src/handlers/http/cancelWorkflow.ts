import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateCancelWorkflowRequest,
  type ValidatedCancelWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { cancelWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.cancel',
  bodySchema: cancelWorkflowHttpBodySchema,
  validator: validateCancelWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleCancel(req as ValidatedCancelWorkflowRequest),
});

export default main;
