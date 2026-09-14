import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepStartRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.start',
  bodySchema: stepActionHttpBodySchema,
  validator: validateStepStartRequest,
  handle: (ctrl, req) => ctrl.handleStepStart(req as ValidatedStepActionRequest),
});

export default main;
