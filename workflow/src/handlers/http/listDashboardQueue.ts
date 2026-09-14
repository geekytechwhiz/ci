import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateDashboardQueueRequest,
  type ValidatedDashboardQueueRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.dashboardQueue',
  validator: validateDashboardQueueRequest,
  handle: (ctrl, req) => ctrl.handleDashboardQueue(req as ValidatedDashboardQueueRequest),
});

export default main;
