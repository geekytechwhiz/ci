import { createTemplateHttpHandler } from './template-handler.factory';
import { validateListPlatformWorkflowTemplateHistoryRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.history',
  validator: validateListPlatformWorkflowTemplateHistoryRequest,
  method: 'handleListHistory',
});

export default main;
