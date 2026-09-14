import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateChecklistStartRequest,
  type ValidatedChecklistActionRequest,
} from '../../validators/workflow-runtime.validators';
import { checklistActionHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.start',
  bodySchema: checklistActionHttpBodySchema,
  validator: validateChecklistStartRequest,
  handle: (ctrl, req) => ctrl.handleChecklistStart(req as ValidatedChecklistActionRequest),
});

export default main;
