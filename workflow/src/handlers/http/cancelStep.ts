import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepCancelRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.cancel',
  bodySchema: stepActionWithReasonHttpBodySchema,
  validator: validateStepCancelRequest,
  handle: (ctrl, req) => ctrl.handleStepCancel(req as ValidatedStepActionRequest),
});

export default main;
