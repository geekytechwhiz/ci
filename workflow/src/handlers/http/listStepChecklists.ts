import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateListStepChecklistsRequest,
  type ValidatedListStepChecklistsRequest,
} from '../../validators/workflow-runtime.validators';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.listByStep',
  validator: validateListStepChecklistsRequest,
  handle: (ctrl, req) =>
    ctrl.handleListChecklistsByStep(req as ValidatedListStepChecklistsRequest),
});

export default main;
