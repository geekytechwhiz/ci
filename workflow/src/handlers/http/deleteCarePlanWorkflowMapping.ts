import { createCarePlanMappingHttpHandler } from './template-handler.factory';
import { deleteCarePlanWorkflowMappingHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateDeleteCarePlanWorkflowMappingRequest } from '../../validators/workflow-template.validators';

export const main = createCarePlanMappingHttpHandler({
  operation: 'workflow.carePlanMapping.delete',
  bodySchema: deleteCarePlanWorkflowMappingHttpBodySchema,
  validator: validateDeleteCarePlanWorkflowMappingRequest,
  method: 'handleDelete',
});

export default main;
