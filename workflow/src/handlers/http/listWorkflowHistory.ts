import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateListHistoryRequest,
  type ValidatedListHistoryRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.history',
  validator: validateListHistoryRequest,
  handle: (ctrl, req) => ctrl.handleListHistory(req as ValidatedListHistoryRequest),
});

export default main;
