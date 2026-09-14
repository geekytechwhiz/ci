import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateReadinessRequest,
  type ValidatedReadinessRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.readiness',
  validator: validateReadinessRequest,
  handle: (ctrl, req) => ctrl.handleCompletionReadiness(req as ValidatedReadinessRequest),
});

export default main;
