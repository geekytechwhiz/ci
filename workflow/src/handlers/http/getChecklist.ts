import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateGetChecklistRequest,
  type ValidatedGetChecklistRequest,
} from '../../validators/workflow-runtime.validators';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.get',
  validator: validateGetChecklistRequest,
  handle: (ctrl, req) => ctrl.handleGetChecklist(req as ValidatedGetChecklistRequest),
});

export default main;
