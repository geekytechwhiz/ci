import { createTemplateHttpHandler } from './template-handler.factory';
import { cloneWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateCloneOrgWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.clone',
  bodySchema: cloneWorkflowTemplateHttpBodySchema,
  validator: validateCloneOrgWorkflowTemplateRequest,
  method: 'handleClone',
});

export default main;
