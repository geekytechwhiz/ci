import { createTemplateHttpHandler } from './template-handler.factory';
import { cloneOrgWorkflowTemplatesForCarePlanHttpBodySchema } from '../../validators/workflow-template.schemas';
import { validateCloneOrgWorkflowTemplatesForCarePlanRequest } from '../../validators/workflow-template.validators';

export const main = createTemplateHttpHandler({
  operation: 'workflow.template.org.cloneForCarePlan',
  bodySchema: cloneOrgWorkflowTemplatesForCarePlanHttpBodySchema,
  validator: validateCloneOrgWorkflowTemplatesForCarePlanRequest,
  method: 'handleCloneOrgTemplatesForCarePlan',
});

export default main;
