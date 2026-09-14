import type { LambdaRequest } from '@api-hub/utils';

import { requireInternalServiceActor } from './workflow-template.validators';
import type {
  FinalizeCarePlanCreationSessionHttpBody,
  PublishCarePlanCreationSessionWorkflowsHttpBody,
  ReserveCarePlanCreationSessionHttpBody,
  StartCarePlanCreationSessionHttpBody,
} from './care-plan-creation-session.schemas';

function requirePathParam(req: LambdaRequest, name: string): string {
  const raw = req.pathParameters?.[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(`${name} path parameter is required`);
  }
  return value;
}

export type ValidatedStartCarePlanCreationSessionRequest = LambdaRequest & {
  validatedStartCarePlanCreationSession: {
    organizationId: string;
    userId?: string;
    body: StartCarePlanCreationSessionHttpBody;
  };
};

export type ValidatedGetCarePlanCreationSessionRequest = LambdaRequest & {
  validatedGetCarePlanCreationSession: {
    organizationId: string;
    creationSessionId: string;
  };
};

export type ValidatedDiscardCarePlanCreationSessionRequest = LambdaRequest & {
  validatedDiscardCarePlanCreationSession: {
    organizationId: string;
    creationSessionId: string;
  };
};

export type ValidatedFinalizeCarePlanCreationSessionRequest = LambdaRequest & {
  validatedFinalizeCarePlanCreationSession: {
    organizationId: string;
    userId?: string;
    creationSessionId: string;
    body: FinalizeCarePlanCreationSessionHttpBody;
  };
};

export type ValidatedReserveCarePlanCreationSessionRequest = LambdaRequest & {
  validatedReserveCarePlanCreationSession: {
    organizationId: string;
    userId?: string;
    creationSessionId: string;
    body: ReserveCarePlanCreationSessionHttpBody;
  };
};

export type ValidatedPublishCarePlanCreationSessionWorkflowsRequest =
  LambdaRequest & {
    validatedPublishCarePlanCreationSessionWorkflows: {
      organizationId: string;
      userId?: string;
      creationSessionId: string;
      body: PublishCarePlanCreationSessionWorkflowsHttpBody;
    };
  };

export async function validateStartCarePlanCreationSessionRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (req as ValidatedStartCarePlanCreationSessionRequest).validatedStartCarePlanCreationSession =
    {
      organizationId,
      userId,
      body: req.body as StartCarePlanCreationSessionHttpBody,
    };
}

export async function validateGetCarePlanCreationSessionRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId } = await requireInternalServiceActor(req);
  (req as ValidatedGetCarePlanCreationSessionRequest).validatedGetCarePlanCreationSession =
    {
      organizationId,
      creationSessionId: requirePathParam(req, 'creationSessionId'),
    };
}

export async function validateDiscardCarePlanCreationSessionRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId } = await requireInternalServiceActor(req);
  (req as ValidatedDiscardCarePlanCreationSessionRequest).validatedDiscardCarePlanCreationSession =
    {
      organizationId,
      creationSessionId: requirePathParam(req, 'creationSessionId'),
    };
}

export async function validateFinalizeCarePlanCreationSessionRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (req as ValidatedFinalizeCarePlanCreationSessionRequest).validatedFinalizeCarePlanCreationSession =
    {
      organizationId,
      userId,
      creationSessionId: requirePathParam(req, 'creationSessionId'),
      body: req.body as FinalizeCarePlanCreationSessionHttpBody,
    };
}

export async function validateReserveCarePlanCreationSessionRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (req as ValidatedReserveCarePlanCreationSessionRequest).validatedReserveCarePlanCreationSession =
    {
      organizationId,
      userId,
      creationSessionId: requirePathParam(req, 'creationSessionId'),
      body: req.body as ReserveCarePlanCreationSessionHttpBody,
    };
}

export async function validatePublishCarePlanCreationSessionWorkflowsRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (
    req as ValidatedPublishCarePlanCreationSessionWorkflowsRequest
  ).validatedPublishCarePlanCreationSessionWorkflows = {
    organizationId,
    userId,
    creationSessionId: requirePathParam(req, 'creationSessionId'),
    body: (req.body ?? {}) as PublishCarePlanCreationSessionWorkflowsHttpBody,
  };
}
