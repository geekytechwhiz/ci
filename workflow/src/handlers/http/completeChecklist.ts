import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistCompleteRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.complete',
  bodySchema: checklistActionHttpBodySchema,
  validator: validateChecklistCompleteRequest,
  handle: (ctrl, req) => ctrl.handleChecklistComplete(req as ValidatedChecklistActionRequest),
});

export default main;
