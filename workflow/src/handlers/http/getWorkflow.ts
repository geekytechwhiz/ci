import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateGetWorkflowRequest,
  type ValidatedGetWorkflowRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.get',
  validator: validateGetWorkflowRequest,
  handle: (ctrl, req) => ctrl.handleGetWorkflow(req as ValidatedGetWorkflowRequest),
});

export default main;
