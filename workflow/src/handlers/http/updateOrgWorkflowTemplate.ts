import { createTemplateHttpHandler } from './template-handler.factory';
import { updateWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateUpdateOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.update',
  bodySchema: updateWorkflowTemplateHttpBodySchema,
  validator: validateUpdateOrgWorkflowTemplateRequest,
  method: 'handleUpdate',
});

export default main;
