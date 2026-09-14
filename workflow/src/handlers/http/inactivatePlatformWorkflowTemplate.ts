import { createTemplateHttpHandler } from './template-handler.factory';
import { inactivateWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateInactivatePlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.inactivate',
  bodySchema: inactivateWorkflowTemplateHttpBodySchema,
  validator: validateInactivatePlatformWorkflowTemplateRequest,
  method: 'handleInactivate',
});

export default main;
