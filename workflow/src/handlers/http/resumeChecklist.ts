import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistResumeRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.resume',
  bodySchema: checklistActionHttpBodySchema,
  validator: validateChecklistResumeRequest,
  handle: (ctrl, req) => ctrl.handleChecklistResume(req as ValidatedChecklistActionRequest),
});

export default main;
