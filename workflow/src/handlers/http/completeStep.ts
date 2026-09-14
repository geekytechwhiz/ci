import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepCompleteRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.complete',
  bodySchema: stepActionHttpBodySchema,
  validator: validateStepCompleteRequest,
  handle: (ctrl, req) => ctrl.handleStepComplete(req as ValidatedStepActionRequest),
});

export default main;
