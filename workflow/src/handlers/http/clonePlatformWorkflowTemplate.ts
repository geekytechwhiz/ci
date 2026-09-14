import { createTemplateHttpHandler } from './template-handler.factory';
import { cloneWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateClonePlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.clone',
  bodySchema: cloneWorkflowTemplateHttpBodySchema,
  validator: validateClonePlatformWorkflowTemplateRequest,
  method: 'handleClone',
});

export default main;
