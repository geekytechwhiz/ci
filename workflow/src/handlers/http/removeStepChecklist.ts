import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateRemoveStepChecklistRequest,
  type ValidatedRemoveStepChecklistRequest,
} from '../../validators/workflow-runtime.validators';
import { removeStructureHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.structure.checklist.remove',
  bodySchema: removeStructureHttpBodySchema,
  validator: validateRemoveStepChecklistRequest,
  handle: (ctrl, req) =>
    ctrl.handleRemoveChecklist(req as ValidatedRemoveStepChecklistRequest),
});

export default main;
