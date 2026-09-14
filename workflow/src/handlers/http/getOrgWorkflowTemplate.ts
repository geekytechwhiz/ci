import { createTemplateHttpHandler } from './template-handler.factory';
import { validateGetOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.get',
  validator: validateGetOrgWorkflowTemplateRequest,
  method: 'handleGet',
});

export default main;
