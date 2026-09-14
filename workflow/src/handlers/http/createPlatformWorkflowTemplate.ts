import { createTemplateHttpHandler } from './template-handler.factory';
import { createWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateCreatePlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.create',
  bodySchema: createWorkflowTemplateHttpBodySchema,
  validator: validateCreatePlatformWorkflowTemplateRequest,
  method: 'handleCreate',
});

export default main;
