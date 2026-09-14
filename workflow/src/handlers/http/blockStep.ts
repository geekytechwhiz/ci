import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepBlockRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.block',
  bodySchema: stepActionWithReasonHttpBodySchema,
  validator: validateStepBlockRequest,
  handle: (ctrl, req) => ctrl.handleStepBlock(req as ValidatedStepActionRequest),
});

export default main;
