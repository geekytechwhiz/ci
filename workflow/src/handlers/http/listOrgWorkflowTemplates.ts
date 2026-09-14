import { createTemplateHttpHandler } from './template-handler.factory';
import { validateListOrgWorkflowTemplatesRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.list',
  validator: validateListOrgWorkflowTemplatesRequest,
  method: 'handleList',
});

export default main;
