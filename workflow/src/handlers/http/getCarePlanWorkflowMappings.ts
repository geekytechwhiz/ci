import { createCarePlanMappingHttpHandler } from './template-handler.factory';
import { validateGetCarePlanWorkflowMappingsRequest } from '../../validators/workflow-template.validators';

export const main = createCarePlanMappingHttpHandler({
  operation: 'workflow.carePlanMapping.get',
  validator: validateGetCarePlanWorkflowMappingsRequest,
  method: 'handleGet',
});

export default main;
