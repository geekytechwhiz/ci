import { createLogger } from '@api-hub/observability';
import {
  CarePlanCreationSessionService,
  CARE_PLAN_CREATION_SESSION_STATUS,
} from '@api-hub/workflow-runtime-core';

import { okData, createdWithEtag } from '../utils/definition-http-response';
import type { LambdaRequest } from '@api-hub/utils';

function toSessionDto(session: {
  creationSessionId: string;
  sourceOrgTemplateId: string;
  status: string;
  workflowMappings: Array<{
    workflowStage: string;
    workflowTemplateId: string;
    sourceWorkflowTemplateId: string;
  }>;
  carePlanTemplateId?: string;
}) {
  return {
    creationSessionId: session.creationSessionId,
    sourceOrgTemplateId: session.sourceOrgTemplateId,
    status: session.status,
    workflowMappings: session.workflowMappings,
    carePlanTemplateId: session.carePlanTemplateId,
  };
}

let ctrl: CarePlanCreationSessionHttpController | undefined;

export function getCarePlanCreationSessionHttpController(deps?: {
  sessions?: CarePlanCreationSessionService;
}): CarePlanCreationSessionHttpController {
  if (!ctrl) {
    ctrl = new CarePlanCreationSessionHttpController(deps);
  }
  return ctrl;
}

export function resetCarePlanCreationSessionHttpControllerForTests(): void {
  ctrl = undefined;
}

export class CarePlanCreationSessionHttpController {
  private readonly sessions: CarePlanCreationSessionService;
  private readonly logger = createLogger({
    serviceName: 'care-plan-creation-session-http',
  });

  constructor(deps?: { sessions?: CarePlanCreationSessionService }) {
    this.sessions = deps?.sessions ?? new CarePlanCreationSessionService();
  }

  async handleStart(req: LambdaRequest & {
    validatedStartCarePlanCreationSession: {
      organizationId: string;
      userId?: string;
      body: {
        sourceOrgTemplateId: string;
        mappings: Array<{ workflowStage: string; workflowTemplateId: string }>;
        clientRequestId?: string;
      };
    };
  }) {
    const v = req.validatedStartCarePlanCreationSession;
    this.logger.info({
      event: 'care_plan_creation_session_start',
      organizationId: v.organizationId,
      sourceOrgTemplateId: v.body.sourceOrgTemplateId,
      mappingCount: v.body.mappings.length,
    });
    const session = await this.sessions.start({
      organizationId: v.organizationId,
      sourceOrgTemplateId: v.body.sourceOrgTemplateId,
      mappings: v.body.mappings,
      clientRequestId: v.body.clientRequestId,
      createdBy: v.userId,
    });
    return createdWithEtag(req, {
      ...toSessionDto(session),
      recordVersion: session.recordVersion,
    });
  }

  async handleGet(req: LambdaRequest & {
    validatedGetCarePlanCreationSession: {
      organizationId: string;
      creationSessionId: string;
    };
  }) {
    const v = req.validatedGetCarePlanCreationSession;
    const session = await this.sessions.get(
      v.organizationId,
      v.creationSessionId,
    );
    return okData(req, toSessionDto(session));
  }

  async handleDiscard(req: LambdaRequest & {
    validatedDiscardCarePlanCreationSession: {
      organizationId: string;
      creationSessionId: string;
    };
  }) {
    const v = req.validatedDiscardCarePlanCreationSession;
    const result = await this.sessions.discard({
      organizationId: v.organizationId,
      creationSessionId: v.creationSessionId,
    });
    return okData(req, {
      creationSessionId: v.creationSessionId,
      status: CARE_PLAN_CREATION_SESSION_STATUS.DISCARDED,
      ...result,
    });
  }

  async handleFinalize(req: LambdaRequest & {
    validatedFinalizeCarePlanCreationSession: {
      organizationId: string;
      userId?: string;
      creationSessionId: string;
      body: { carePlanTemplateId: string };
    };
  }) {
    const v = req.validatedFinalizeCarePlanCreationSession;
    const session = await this.sessions.finalize({
      organizationId: v.organizationId,
      creationSessionId: v.creationSessionId,
      carePlanTemplateId: v.body.carePlanTemplateId,
      updatedBy: v.userId,
    });
    return okData(req, toSessionDto(session));
  }

  async handleReserveCarePlan(req: LambdaRequest & {
    validatedReserveCarePlanCreationSession: {
      organizationId: string;
      userId?: string;
      creationSessionId: string;
      body: { carePlanTemplateId: string };
    };
  }) {
    const v = req.validatedReserveCarePlanCreationSession;
    const session = await this.sessions.reserveCarePlanTemplateId({
      organizationId: v.organizationId,
      creationSessionId: v.creationSessionId,
      carePlanTemplateId: v.body.carePlanTemplateId,
      updatedBy: v.userId,
    });
    return okData(req, toSessionDto(session));
  }

  async handlePublishWorkflows(req: LambdaRequest & {
    validatedPublishCarePlanCreationSessionWorkflows: {
      organizationId: string;
      userId?: string;
      creationSessionId: string;
      body: { carePlanTemplateId?: string };
    };
  }) {
    const v = req.validatedPublishCarePlanCreationSessionWorkflows;
    const result = await this.sessions.publishSessionWorkflows({
      organizationId: v.organizationId,
      creationSessionId: v.creationSessionId,
      carePlanTemplateId: v.body.carePlanTemplateId,
      updatedBy: v.userId,
    });
    return okData(req, {
      ...toSessionDto(result.session),
      publishedWorkflowTemplateIds: result.publishedWorkflowTemplateIds,
      skippedAlreadyPublishedIds: result.skippedAlreadyPublishedIds,
    });
  }
}
