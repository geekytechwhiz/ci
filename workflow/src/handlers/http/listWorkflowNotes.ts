import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateListNotesRequest,
  type ValidatedListNotesRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.notes',
  validator: validateListNotesRequest,
  handle: (ctrl, req) => ctrl.handleListNotes(req as ValidatedListNotesRequest),
});

export default main;
