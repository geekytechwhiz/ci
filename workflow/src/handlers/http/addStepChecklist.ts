import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateAddStepChecklistRequest,
  type ValidatedAddStepChecklistRequest,
} from '../../validators/workflow-runtime.validators';
import { addStepChecklistHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.structure.checklist.add',
  bodySchema: addStepChecklistHttpBodySchema,
  validator: validateAddStepChecklistRequest,
  handle: (ctrl, req) =>
    ctrl.handleAddChecklist(req as ValidatedAddStepChecklistRequest),
});

export default main;
