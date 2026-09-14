import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateAssignChecklistRequest,
  type ValidatedAssignChecklistRequest,
} from '../../validators/workflow-runtime.validators';
import { assignChecklistHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.checklist.assign',
  bodySchema: assignChecklistHttpBodySchema,
  validator: validateAssignChecklistRequest,
  handle: (ctrl, req) => ctrl.handleChecklistAssign(req as ValidatedAssignChecklistRequest),
});

export default main;
