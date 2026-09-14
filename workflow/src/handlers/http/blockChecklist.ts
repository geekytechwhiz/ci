import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistBlockRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionWithReasonHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.block',
  bodySchema: checklistActionWithReasonHttpBodySchema,
  validator: validateChecklistBlockRequest,
  handle: (ctrl, req) => ctrl.handleChecklistBlock(req as ValidatedChecklistActionRequest),
});

export default main;
