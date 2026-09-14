import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateListWorkflowChecklistsRequest,
  type ValidatedListWorkflowChecklistsRequest,
} from '../../validators/workflow-runtime.validators';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.list',
  validator: validateListWorkflowChecklistsRequest,
  handle: (ctrl, req) =>
    ctrl.handleListChecklists(req as ValidatedListWorkflowChecklistsRequest),
});

export default main;
