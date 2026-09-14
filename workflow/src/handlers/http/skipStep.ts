import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepSkipRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.skip',
  bodySchema: stepActionWithReasonHttpBodySchema,
  validator: validateStepSkipRequest,
  handle: (ctrl, req) => ctrl.handleStepSkip(req as ValidatedStepActionRequest),
});

export default main;
