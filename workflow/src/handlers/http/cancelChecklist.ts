import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistCancelRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.cancel',
  bodySchema: checklistActionWithReasonHttpBodySchema,
  validator: validateChecklistCancelRequest,
  handle: (ctrl, req) => ctrl.handleChecklistCancel(req as ValidatedChecklistActionRequest),
});

export default main;
