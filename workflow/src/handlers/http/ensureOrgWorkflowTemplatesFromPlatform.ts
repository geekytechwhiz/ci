import { createTemplateHttpHandler } from './template-handler.factory';
import { putCarePlanWorkflowMappingsHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateEnsureOrgWorkflowTemplatesFromPlatformRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.ensureFromPlatform',
  bodySchema: putCarePlanWorkflowMappingsHttpBodySchema,
  validator: validateEnsureOrgWorkflowTemplatesFromPlatformRequest,
  method: 'handleEnsureFromPlatform',
});

export default main;
