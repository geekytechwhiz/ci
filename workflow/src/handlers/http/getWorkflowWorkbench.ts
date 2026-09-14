import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateWorkbenchRequest,
  type ValidatedWorkbenchRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.workbench',
  validator: validateWorkbenchRequest,
  handle: (ctrl, req) => ctrl.handleWorkbench(req as ValidatedWorkbenchRequest),
});

export default main;
