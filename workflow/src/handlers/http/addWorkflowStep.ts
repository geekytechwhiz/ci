import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateAddWorkflowStepRequest,
  type ValidatedAddWorkflowStepRequest,
} from '../../validators/workflow-runtime.validators';
import { addWorkflowStepHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.structure.step.add',
  bodySchema: addWorkflowStepHttpBodySchema,
  validator: validateAddWorkflowStepRequest,
  handle: (ctrl, req) =>
    ctrl.handleAddStep(req as ValidatedAddWorkflowStepRequest),
});

export default main;
