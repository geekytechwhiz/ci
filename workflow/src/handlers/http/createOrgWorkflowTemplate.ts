import { createTemplateHttpHandler } from './template-handler.factory';
import { createWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateCreateOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.create',
  bodySchema: createWorkflowTemplateHttpBodySchema,
  validator: validateCreateOrgWorkflowTemplateRequest,
  method: 'handleCreate',
});

export default main;
