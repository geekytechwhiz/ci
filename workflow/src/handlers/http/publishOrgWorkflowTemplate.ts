import { createTemplateHttpHandler } from './template-handler.factory';
import { publishWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validatePublishOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.publish',
  bodySchema: publishWorkflowTemplateHttpBodySchema,
  validator: validatePublishOrgWorkflowTemplateRequest,
  method: 'handlePublish',
});

export default main;
