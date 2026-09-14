import { createTemplateHttpHandler } from './template-handler.factory';
import { validateGetPlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.get',
  validator: validateGetPlatformWorkflowTemplateRequest,
  method: 'handleGet',
});

export default main;
