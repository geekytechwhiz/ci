import { createRuntimeQueryHandler } from './query-handler.factory';
import {
  validateListEvidenceRequest,
  type ValidatedListEvidenceRequest,
} from '../../validators/workflow-query.validators';

export const main = createRuntimeQueryHandler({
  operation: 'workflow.query.evidence',
  validator: validateListEvidenceRequest,
  handle: (ctrl, req) => ctrl.handleListEvidence(req as ValidatedListEvidenceRequest),
});

export default main;
