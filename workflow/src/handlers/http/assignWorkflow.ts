import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateAssignWorkflowRequest,
  type ValidatedAssignWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { assignWorkflowHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.assign',
  bodySchema: assignWorkflowHttpBodySchema,
  validator: validateAssignWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleAssign(req as ValidatedAssignWorkflowRequest),
});

export default main;
