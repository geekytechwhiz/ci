import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateStepResumeRequest,
  type ValidatedStepActionRequest,
} from '../../validators/workflow-runtime.validators';
import { stepActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.step.resume',
  bodySchema: stepActionHttpBodySchema,
  validator: validateStepResumeRequest,
  handle: (ctrl, req) => ctrl.handleStepResume(req as ValidatedStepActionRequest),
});

export default main;
