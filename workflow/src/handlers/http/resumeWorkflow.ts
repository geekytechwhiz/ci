import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateResumeWorkflowRequest,
  type ValidatedResumeWorkflowRequest,
} from '../../validators/workflow-runtime.validators';
import { optionalOccBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.resume',
  bodySchema: optionalOccBodySchema,
  validator: validateResumeWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleResume(req as ValidatedResumeWorkflowRequest),
});

export default main;
