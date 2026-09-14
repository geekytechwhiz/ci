import { createCarePlanMappingHttpHandler } from './template-handler.factory';
import { putCarePlanWorkflowMappingsHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validatePutCarePlanWorkflowMappingsRequest } from '../../validators/workflow-template.validators';

export const main = createCarePlanMappingHttpHandler({
  operation: 'workflow.carePlanMapping.put',
  bodySchema: putCarePlanWorkflowMappingsHttpBodySchema,
  validator: validatePutCarePlanWorkflowMappingsRequest,
  method: 'handlePut',
});

export default main;
