import { createTemplateHttpHandler } from './template-handler.factory';
import { updateWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateUpdatePlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.update',
  bodySchema: updateWorkflowTemplateHttpBodySchema,
  validator: validateUpdatePlatformWorkflowTemplateRequest,
  method: 'handleUpdate',
});

export default main;
