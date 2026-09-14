import { createRuntimeCommandHandler } from './runtime-handler.factory';
import {
  validateRemoveWorkflowStepRequest,
  type ValidatedRemoveWorkflowStepRequest,
} from '../../validators/workflow-runtime.validators';
import { removeStructureHttpBodySchema } from '../../validators/workflow-runtime.schemas';

export const main = createRuntimeCommandHandler({
  operation: 'workflow.runtime.structure.step.remove',
  bodySchema: removeStructureHttpBodySchema,
  validator: validateRemoveWorkflowStepRequest,
  handle: (ctrl, req) =>
    ctrl.handleRemoveStep(req as ValidatedRemoveWorkflowStepRequest),
});

export default main;
