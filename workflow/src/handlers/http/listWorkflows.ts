import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateListWorkflowsRequest,
  type ValidatedListWorkflowsRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.list',
  validator: validateListWorkflowsRequest,
  handle: (ctrl, req) => ctrl.handleListWorkflows(req as ValidatedListWorkflowsRequest),
});

export default main;
