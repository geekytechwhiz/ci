import { createTemplateHttpHandler } from './template-handler.factory';
import { publishWorkflowTemplateHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validatePublishPlatformWorkflowTemplateRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.platform.publish',
  bodySchema: publishWorkflowTemplateHttpBodySchema,
  validator: validatePublishPlatformWorkflowTemplateRequest,
  method: 'handlePublish',
});

export default main;
