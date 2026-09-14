import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateAssignStepRequest,
  type ValidatedAssignStepRequest,
} from '../../validators/workflow-runtime.validators';
import { assignStepHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.assign',
  bodySchema: assignStepHttpBodySchema,
  validator: validateAssignStepRequest,
  handle: (ctrl, req) => ctrl.handleStepAssign(req as ValidatedAssignStepRequest),
});

export default main;
