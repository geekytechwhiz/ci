import { createTemplateHttpHandler } from './template-handler.factory';
import { inactivateWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateInactivateOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.inactivate',
  bodySchema: inactivateWorkflowTemplateHttpBodySchema,
  validator: validateInactivateOrgWorkflowTemplateRequest,
  method: 'handleInactivate',
});

export default main;
