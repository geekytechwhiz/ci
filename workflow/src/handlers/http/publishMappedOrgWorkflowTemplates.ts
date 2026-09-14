import { createTemplateHttpHandler } from './template-handler.factory';
import { publishMappedOrgWorkflowTemplatesHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validatePublishMappedOrgWorkflowTemplatesRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.publishMapped',
  bodySchema: publishMappedOrgWorkflowTemplatesHttpBodySchema,
  validator: validatePublishMappedOrgWorkflowTemplatesRequest,
  method: 'handlePublishMappedOrgTemplates',
});

export default main;
