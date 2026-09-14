import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistSkipRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.skip',
  bodySchema: checklistActionHttpBodySchema,
  validator: validateChecklistSkipRequest,
  handle: (ctrl, req) => ctrl.handleChecklistSkip(req as ValidatedChecklistActionRequest),
});

export default main;
