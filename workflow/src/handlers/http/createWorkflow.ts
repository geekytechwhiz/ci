import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateCreateWorkflowRequest,
  type ValidatedCreateWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { createWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.create',
  bodySchema: createWorkflowHttpBodySchema,
  validator: validateCreateWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleCreate(req as ValidatedCreateWorkflowRequest),
});

export default main;
