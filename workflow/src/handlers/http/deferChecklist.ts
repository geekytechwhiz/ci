import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistDeferRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.defer',
  bodySchema: checklistActionHttpBodySchema,
  validator: validateChecklistDeferRequest,
  handle: (ctrl, req) => ctrl.handleChecklistDefer(req as ValidatedChecklistActionRequest),
});

export default main;
