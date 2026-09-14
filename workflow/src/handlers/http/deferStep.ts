import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepDeferRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.defer',
  bodySchema: stepActionWithReasonHttpBodySchema,
  validator: validateStepDeferRequest,
  handle: (ctrl, req) => ctrl.handleStepDefer(req as ValidatedStepActionRequest),
});

export default main;
