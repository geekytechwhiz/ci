/**
 * POC HTTP dispatcher: one Lambda for every API Gateway route.
 *
 * Existing handler modules stay as internal implementations. This file only
 * binds those handlers and delegates matching to http-router.ts.
 */
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
  Handler,
} from 'aws-lambda';

import { main as addStepChecklist } from './addStepChecklist';
import { main as addWorkflowStep } from './addWorkflowStep';
import { main as assignChecklist } from './assignChecklist';
import { main as assignStep } from './assignStep';
import { main as assignWorkflow } from './assignWorkflow';
import { main as blockChecklist } from './blockChecklist';
import { main as blockStep } from './blockStep';
import { main as blockWorkflow } from './blockWorkflow';
import {
  discardMain as discardCarePlanCreationSession,
  finalizeMain as finalizeCarePlanCreationSession,
  getMain as getCarePlanCreationSession,
  publishWorkflowsMain as publishCarePlanCreationSessionWorkflows,
  reserveCarePlanMain as reserveCarePlanCreationSession,
  startMain as startCarePlanCreationSession,
} from './carePlanCreationSession';
import { main as cancelChecklist } from './cancelChecklist';
import { main as cancelStep } from './cancelStep';
import { main as cancelWorkflow } from './cancelWorkflow';
import { main as cloneOrgWorkflowTemplate } from './cloneOrgWorkflowTemplate';
import { main as cloneOrgWorkflowTemplatesForCarePlan } from './cloneOrgWorkflowTemplatesForCarePlan';
import { main as clonePlatformWorkflowTemplate } from './clonePlatformWorkflowTemplate';
import { main as completeChecklist } from './completeChecklist';
import { main as completeStep } from './completeStep';
import { main as completeWorkflow } from './completeWorkflow';
import { main as createOrgWorkflowTemplate } from './createOrgWorkflowTemplate';
import { main as createPlatformWorkflowTemplate } from './createPlatformWorkflowTemplate';
import { main as createWorkflow } from './createWorkflow';
import { main as deferChecklist } from './deferChecklist';
import { main as deferStep } from './deferStep';
import { main as deleteCarePlanWorkflowMapping } from './deleteCarePlanWorkflowMapping';
import { main as ensureOrgWorkflowTemplatesFromPlatform } from './ensureOrgWorkflowTemplatesFromPlatform';
import { main as getCarePlanWorkflowMappings } from './getCarePlanWorkflowMappings';
import { main as getChecklist } from './getChecklist';
import { main as getOrgWorkflowTemplate } from './getOrgWorkflowTemplate';
import { main as getPlatformWorkflowTemplate } from './getPlatformWorkflowTemplate';
import { main as getWorkflow } from './getWorkflow';
import { main as getWorkflowCompletionReadiness } from './getWorkflowCompletionReadiness';
import { main as getWorkflowWorkbench } from './getWorkflowWorkbench';
import { main as health } from './health';
import {
  dispatchHttpEvent,
  HTTP_ROUTE_DEFS,
  routeKey,
  type HttpRouteDef,
} from './http-router';
import { main as inactivateOrgWorkflowTemplate } from './inactivateOrgWorkflowTemplate';
import { main as inactivatePlatformWorkflowTemplate } from './inactivatePlatformWorkflowTemplate';
import { main as listDashboardQueue } from './listDashboardQueue';
import { main as listOrgWorkflowTemplates } from './listOrgWorkflowTemplates';
import { main as listPlatformWorkflowTemplateHistory } from './listPlatformWorkflowTemplateHistory';
import { main as listPlatformWorkflowTemplates } from './listPlatformWorkflowTemplates';
import { main as listStepChecklists } from './listStepChecklists';
import { main as listWorkflowChecklists } from './listWorkflowChecklists';
import { main as listWorkflowEvidence } from './listWorkflowEvidence';
import { main as listWorkflowHistory } from './listWorkflowHistory';
import { main as listWorkflowNotes } from './listWorkflowNotes';
import { main as listWorkflows } from './listWorkflows';
import { main as publishMappedOrgWorkflowTemplates } from './publishMappedOrgWorkflowTemplates';
import { main as publishOrgWorkflowTemplate } from './publishOrgWorkflowTemplate';
import { main as publishPlatformWorkflowTemplate } from './publishPlatformWorkflowTemplate';
import { main as putCarePlanWorkflowMappings } from './putCarePlanWorkflowMappings';
import { main as removeStepChecklist } from './removeStepChecklist';
import { main as removeWorkflowStep } from './removeWorkflowStep';
import { main as resumeChecklist } from './resumeChecklist';
import { main as resumeStep } from './resumeStep';
import { main as resumeWorkflow } from './resumeWorkflow';
import { main as skipChecklist } from './skipChecklist';
import { main as skipStep } from './skipStep';
import { main as startChecklist } from './startChecklist';
import { main as startStep } from './startStep';
import { main as startWorkflow } from './startWorkflow';
import { main as updateOrgWorkflowTemplate } from './updateOrgWorkflowTemplate';
import { main as updatePlatformWorkflowTemplate } from './updatePlatformWorkflowTemplate';
import { main as waitStep } from './waitStep';
import { main as waitWorkflow } from './waitWorkflow';

type BoundHandler = (
  event: APIGatewayProxyEvent,
  context: Context,
) => Promise<APIGatewayProxyResult | undefined>;

const HANDLERS: Record<string, BoundHandler> = {
  'GET /health': health,
  'POST /v1/platform/workflow-templates': createPlatformWorkflowTemplate,
  'PUT /v1/platform/workflow-templates/{templateId}':
    updatePlatformWorkflowTemplate,
  'POST /v1/platform/workflow-templates/{templateId}/publish':
    publishPlatformWorkflowTemplate,
  'POST /v1/platform/workflow-templates/{templateId}/inactivate':
    inactivatePlatformWorkflowTemplate,
  'POST /v1/platform/workflow-templates/{templateId}/clone':
    clonePlatformWorkflowTemplate,
  'GET /v1/platform/workflow-templates/{templateId}':
    getPlatformWorkflowTemplate,
  'GET /v1/platform/workflow-templates/{templateId}/history':
    listPlatformWorkflowTemplateHistory,
  'GET /v1/platform/workflow-templates': listPlatformWorkflowTemplates,
  'POST /v1/organizations/{orgId}/workflow-templates':
    createOrgWorkflowTemplate,
  'PUT /v1/organizations/{orgId}/workflow-templates/{templateId}':
    updateOrgWorkflowTemplate,
  'POST /v1/organizations/{orgId}/workflow-templates/{templateId}/publish':
    publishOrgWorkflowTemplate,
  'POST /v1/organizations/{orgId}/workflow-templates/{templateId}/inactivate':
    inactivateOrgWorkflowTemplate,
  'POST /v1/organizations/{orgId}/workflow-templates/{templateId}/clone':
    cloneOrgWorkflowTemplate,
  'GET /v1/organizations/{orgId}/workflow-templates/{templateId}':
    getOrgWorkflowTemplate,
  'GET /v1/organizations/{orgId}/workflow-templates': listOrgWorkflowTemplates,
  'POST /v1/organizations/{orgId}/workflow-templates/from-platform':
    ensureOrgWorkflowTemplatesFromPlatform,
  'POST /v1/organizations/{orgId}/workflow-templates/clone-for-care-plan':
    cloneOrgWorkflowTemplatesForCarePlan,
  'POST /v1/organizations/{orgId}/workflow-templates/publish-mapped':
    publishMappedOrgWorkflowTemplates,
  'POST /v1/organizations/{orgId}/care-plan-creation-sessions':
    startCarePlanCreationSession,
  'GET /v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}':
    getCarePlanCreationSession,
  'DELETE /v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}':
    discardCarePlanCreationSession,
  'POST /v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/finalize':
    finalizeCarePlanCreationSession,
  'POST /v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/reserve-care-plan':
    reserveCarePlanCreationSession,
  'POST /v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/publish-workflows':
    publishCarePlanCreationSessionWorkflows,
  'GET /v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings':
    getCarePlanWorkflowMappings,
  'PUT /v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings':
    putCarePlanWorkflowMappings,
  'DELETE /v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings/{workflowStage}':
    deleteCarePlanWorkflowMapping,
  'POST /v1/workflows': createWorkflow,
  'POST /v1/workflows/{workflowId}/start': startWorkflow,
  'POST /v1/workflows/{workflowId}/assign': assignWorkflow,
  'POST /v1/workflows/{workflowId}/wait': waitWorkflow,
  'POST /v1/workflows/{workflowId}/block': blockWorkflow,
  'POST /v1/workflows/{workflowId}/resume': resumeWorkflow,
  'POST /v1/workflows/{workflowId}/complete': completeWorkflow,
  'POST /v1/workflows/{workflowId}/cancel': cancelWorkflow,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/start': startStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/complete': completeStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/skip': skipStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/wait': waitStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/block': blockStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/resume': resumeStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/defer': deferStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/cancel': cancelStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/assign': assignStep,
  'POST /v1/workflows/{workflowId}/steps': addWorkflowStep,
  'DELETE /v1/workflows/{workflowId}/steps/{stepId}': removeWorkflowStep,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists': addStepChecklist,
  'DELETE /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}':
    removeStepChecklist,
  'GET /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}':
    getChecklist,
  'GET /v1/workflows/{workflowId}/checklists': listWorkflowChecklists,
  'GET /v1/workflows/{workflowId}/steps/{stepId}/checklists': listStepChecklists,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/start':
    startChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/complete':
    completeChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/skip':
    skipChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/defer':
    deferChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/block':
    blockChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/resume':
    resumeChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/cancel':
    cancelChecklist,
  'POST /v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/assign':
    assignChecklist,
  'GET /v1/workflows/{workflowId}': getWorkflow,
  'GET /v1/workflows/{workflowId}/history': listWorkflowHistory,
  'GET /v1/workflows/{workflowId}/notes': listWorkflowNotes,
  'GET /v1/workflows/{workflowId}/evidence': listWorkflowEvidence,
  'GET /v1/workflows': listWorkflows,
  'GET /v1/dashboard/queue': listDashboardQueue,
  'GET /v1/workflows/{workflowId}/workbench': getWorkflowWorkbench,
  'GET /v1/workflows/{workflowId}/completion-readiness':
    getWorkflowCompletionReadiness,
};

function resolveHandler(route: HttpRouteDef): BoundHandler | undefined {
  return HANDLERS[routeKey(route)];
}

const unbound = HTTP_ROUTE_DEFS.filter((route) => !HANDLERS[routeKey(route)]);
if (unbound.length > 0) {
  throw new Error(
    `API dispatcher missing handlers for: ${unbound.map(routeKey).join(', ')}`,
  );
}

export const main: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> =
  async (event, context: Context) => {
    return dispatchHttpEvent(event, context, resolveHandler);
  };

export default main;
