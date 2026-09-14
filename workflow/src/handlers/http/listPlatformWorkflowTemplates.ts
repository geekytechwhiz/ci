import { createTemplateHttpHandler } from './template-handler.factory';
import { validateListPlatformWorkflowTemplatesRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.list',
  validator: validateListPlatformWorkflowTemplatesRequest,
  method: 'handleList',
});

export default main;
