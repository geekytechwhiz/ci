import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepWaitRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.wait',
  bodySchema: stepActionWithReasonHttpBodySchema,
  validator: validateStepWaitRequest,
  handle: (ctrl, req) => ctrl.handleStepWait(req as ValidatedStepActionRequest),
});

export default main;
