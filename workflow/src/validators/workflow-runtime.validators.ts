import { BaseError, type LambdaRequest } from '@api-hub/utils';

import { getActorUserIdForRequest, getOrganizationIdForRequest } from '../utils/helpers';
import { readHeader } from '../utils/occ';
import type {
  AddStepChecklistHttpBody,
  AddWorkflowStepHttpBody,
  AssignChecklistHttpBody,
  AssignStepHttpBody,
  AssignWorkflowHttpBody,
  CancelWorkflowHttpBody,
  ChecklistActionHttpBody,
  CompleteWorkflowHttpBody,
  CreateWorkflowHttpBody,
  OptionalOccBody,
  ReasonWorkflowHttpBody,
  StepActionHttpBody,
} from './workflow-runtime.schemas';

function unauthorizedOrg(): never {
  throw new BaseError(
    'Organization could not be resolved from the access token',
    401,
    'UNAUTHORIZED',
    [{ message: 'Organization could not be resolved from the access token' }],
    { retryable: false },
  );
}

function requirePathParam(req: LambdaRequest, name: string): string {
  const value = req.pathParameters?.[name]?.trim();
  if (!value) {
    throw new BaseError(
      `${name} path parameter is required`,
      400,
      'VALIDATION_ERROR',
      [{ field: name, message: `${name} is required` }],
      { retryable: false },
    );
  }
  return value;
}

function requireIdempotencyKey(req: LambdaRequest): string {
  const key = readHeader(req.event.headers, 'Idempotency-Key')?.trim();
  if (!key) {
    throw new BaseError(
      'Idempotency-Key header is required',
      400,
      'VALIDATION_ERROR',
      [{ field: 'Idempotency-Key', message: 'Idempotency-Key is required' }],
      { retryable: false },
    );
  }
  return key;
}

function optionalIdempotencyKey(req: LambdaRequest): string | undefined {
  return readHeader(req.event.headers, 'Idempotency-Key')?.trim() || undefined;
}

function orgAndActor(req: LambdaRequest): {
  organizationId: string;
  userId?: string;
  correlationId: string;
  ifMatch?: string;
} {
  const organizationId = getOrganizationIdForRequest(req.event, req.context.authHeader);
  if (!organizationId) unauthorizedOrg();
  return {
    organizationId,
    userId: getActorUserIdForRequest(req.event, req.context.authHeader),
    correlationId: req.context.correlationId ?? 'unknown',
    ifMatch: readHeader(req.event.headers, 'If-Match'),
  };
}

export type ValidatedCreateWorkflow = {
  organizationId: string;
  userId?: string;
  correlationId: string;
  idempotencyKey: string;
  body: CreateWorkflowHttpBody;
};

export type ValidatedWorkflowCommand = {
  organizationId: string;
  userId?: string;
  correlationId: string;
  workflowId: string;
  ifMatch?: string;
  recordVersion?: number;
  idempotencyKey?: string;
  reason?: string;
  body?: unknown;
};

export type ValidatedStepCommand = ValidatedWorkflowCommand & {
  stepId: string;
};

export type ValidatedCreateWorkflowRequest = LambdaRequest & {
  validatedCreateWorkflow: ValidatedCreateWorkflow;
};
export type ValidatedStartWorkflowRequest = LambdaRequest & {
  validatedStartWorkflow: ValidatedWorkflowCommand;
};
export type ValidatedAssignWorkflowRequest = LambdaRequest & {
  validatedAssignWorkflow: ValidatedWorkflowCommand & {
    assigneeType: string;
    assigneeId: string;
    reason?: string;
  };
};
export type ValidatedWaitWorkflowRequest = LambdaRequest & {
  validatedWaitWorkflow: ValidatedWorkflowCommand & { reason: string };
};
export type ValidatedBlockWorkflowRequest = LambdaRequest & {
  validatedBlockWorkflow: ValidatedWorkflowCommand & { reason: string };
};
export type ValidatedResumeWorkflowRequest = LambdaRequest & {
  validatedResumeWorkflow: ValidatedWorkflowCommand;
};
export type ValidatedCompleteWorkflowRequest = LambdaRequest & {
  validatedCompleteWorkflow: ValidatedWorkflowCommand & {
    outcome: string;
    finalNote?: string;
  };
};
export type ValidatedCancelWorkflowRequest = LambdaRequest & {
  validatedCancelWorkflow: ValidatedWorkflowCommand & { reason: string };
};
export type ValidatedStepActionRequest = LambdaRequest & {
  validatedStepAction: ValidatedStepCommand & { reason?: string; note?: string };
};
export type ValidatedAssignStepRequest = LambdaRequest & {
  validatedAssignStep: ValidatedStepCommand & {
    assigneeType: string;
    assigneeId: string;
    reason?: string;
  };
};

export type ValidatedChecklistCommand = ValidatedWorkflowCommand & {
  stepId: string;
  checklistId: string;
};

export type ValidatedChecklistActionRequest = LambdaRequest & {
  validatedChecklistAction: ValidatedChecklistCommand & {
    reason?: string;
    note?: string;
  };
};

export type ValidatedAssignChecklistRequest = LambdaRequest & {
  validatedAssignChecklist: ValidatedChecklistCommand & {
    assigneeType: string;
    assigneeId: string;
    reason?: string;
  };
};

export type ValidatedGetChecklistRequest = LambdaRequest & {
  validatedGetChecklist: ValidatedChecklistCommand;
};

export type ValidatedListWorkflowChecklistsRequest = LambdaRequest & {
  validatedListWorkflowChecklists: {
    organizationId: string;
    userId?: string;
    correlationId: string;
    workflowId: string;
  };
};

export type ValidatedListStepChecklistsRequest = LambdaRequest & {
  validatedListStepChecklists: {
    organizationId: string;
    userId?: string;
    correlationId: string;
    workflowId: string;
    stepId: string;
  };
};

export function validateCreateWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as CreateWorkflowHttpBody;
  (req as ValidatedCreateWorkflowRequest).validatedCreateWorkflow = {
    ...ctx,
    idempotencyKey: requireIdempotencyKey(req),
    body,
  };
}

export function validateStartWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as OptionalOccBody;
  (req as ValidatedStartWorkflowRequest).validatedStartWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: requireIdempotencyKey(req),
  };
}

export function validateAssignWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as AssignWorkflowHttpBody;
  (req as ValidatedAssignWorkflowRequest).validatedAssignWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: requireIdempotencyKey(req),
    assigneeType: body.assigneeType,
    assigneeId: body.assigneeId,
    reason: body.reason,
  };
}

export function validateWaitWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as ReasonWorkflowHttpBody;
  (req as ValidatedWaitWorkflowRequest).validatedWaitWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: optionalIdempotencyKey(req),
    reason: body.reason,
  };
}

export function validateBlockWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as ReasonWorkflowHttpBody;
  (req as ValidatedBlockWorkflowRequest).validatedBlockWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: optionalIdempotencyKey(req),
    reason: body.reason,
  };
}

export function validateResumeWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as OptionalOccBody;
  (req as ValidatedResumeWorkflowRequest).validatedResumeWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: optionalIdempotencyKey(req),
  };
}

export function validateCompleteWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as CompleteWorkflowHttpBody;
  (req as ValidatedCompleteWorkflowRequest).validatedCompleteWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: requireIdempotencyKey(req),
    outcome: body.outcome,
    finalNote: body.finalNote,
  };
}

export function validateCancelWorkflowRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as CancelWorkflowHttpBody;
  (req as ValidatedCancelWorkflowRequest).validatedCancelWorkflow = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    idempotencyKey: requireIdempotencyKey(req),
    reason: body.reason,
  };
}

function validateStepActionBase(
  req: LambdaRequest,
  opts: { requireIdempotency: boolean; requireReason: boolean },
): ValidatedStepCommand & { reason?: string; note?: string } {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as StepActionHttpBody;
  if (opts.requireReason && !body.reason?.trim()) {
    throw new BaseError(
      'reason is required',
      400,
      'VALIDATION_ERROR',
      [{ field: 'reason', message: 'reason is required' }],
      { retryable: false },
    );
  }
  return {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    recordVersion: body.recordVersion,
    idempotencyKey: opts.requireIdempotency
      ? requireIdempotencyKey(req)
      : optionalIdempotencyKey(req),
    reason: body.reason,
    note: body.note,
  };
}

export function validateStepStartRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: false,
  });
}

export function validateStepCompleteRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: false,
  });
}

export function validateStepSkipRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: true,
  });
}

export function validateStepWaitRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: true,
  });
}

export function validateStepBlockRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: true,
  });
}

export function validateStepResumeRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: false,
  });
}

export function validateStepDeferRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: true,
  });
}

export function validateStepCancelRequest(req: LambdaRequest): void {
  (req as ValidatedStepActionRequest).validatedStepAction = validateStepActionBase(req, {
    requireIdempotency: true,
    requireReason: true,
  });
}

export function validateAssignStepRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as AssignStepHttpBody;
  (req as ValidatedAssignStepRequest).validatedAssignStep = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    recordVersion: body.recordVersion,
    assigneeType: body.assigneeType,
    assigneeId: body.assigneeId,
    reason: body.reason,
  };
}

function validateChecklistActionBase(
  req: LambdaRequest,
  opts: { requireIdempotency: boolean; requireReason: boolean },
): ValidatedChecklistCommand & { reason?: string; note?: string } {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as ChecklistActionHttpBody;
  if (opts.requireReason && !body.reason?.trim()) {
    throw new BaseError(
      'reason is required',
      400,
      'VALIDATION_ERROR',
      [{ field: 'reason', message: 'reason is required' }],
      { retryable: false },
    );
  }
  return {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    checklistId: requirePathParam(req, 'checklistId'),
    recordVersion: body.recordVersion,
    idempotencyKey: opts.requireIdempotency
      ? requireIdempotencyKey(req)
      : optionalIdempotencyKey(req),
    reason: body.reason,
    note: body.note,
  };
}

export function validateGetChecklistRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  (req as ValidatedGetChecklistRequest).validatedGetChecklist = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    checklistId: requirePathParam(req, 'checklistId'),
  };
}

export function validateListWorkflowChecklistsRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  (req as ValidatedListWorkflowChecklistsRequest).validatedListWorkflowChecklists = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    correlationId: ctx.correlationId,
    workflowId: requirePathParam(req, 'workflowId'),
  };
}

export function validateListStepChecklistsRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  (req as ValidatedListStepChecklistsRequest).validatedListStepChecklists = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    correlationId: ctx.correlationId,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
  };
}

export function validateChecklistStartRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: false,
    });
}

export function validateChecklistCompleteRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: false,
    });
}

export function validateChecklistSkipRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: false,
    });
}

export function validateChecklistDeferRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: false,
    });
}

export function validateChecklistBlockRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: true,
    });
}

export function validateChecklistResumeRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: false,
    });
}

export function validateChecklistCancelRequest(req: LambdaRequest): void {
  (req as ValidatedChecklistActionRequest).validatedChecklistAction =
    validateChecklistActionBase(req, {
      requireIdempotency: true,
      requireReason: true,
    });
}

export type ValidatedAddWorkflowStepRequest = LambdaRequest & {
  validatedAddWorkflowStep: ValidatedWorkflowCommand & {
    step: AddWorkflowStepHttpBody;
  };
};

export type ValidatedRemoveWorkflowStepRequest = LambdaRequest & {
  validatedRemoveWorkflowStep: ValidatedStepCommand;
};

export type ValidatedAddStepChecklistRequest = LambdaRequest & {
  validatedAddStepChecklist: ValidatedStepCommand & {
    checklist: AddStepChecklistHttpBody;
  };
};

export type ValidatedRemoveStepChecklistRequest = LambdaRequest & {
  validatedRemoveStepChecklist: ValidatedChecklistCommand;
};

export function validateAddWorkflowStepRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as AddWorkflowStepHttpBody;
  (req as ValidatedAddWorkflowStepRequest).validatedAddWorkflowStep = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    recordVersion: body.recordVersion,
    reason: body.reason,
    step: body,
  };
}

export function validateRemoveWorkflowStepRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as OptionalOccBody;
  (req as ValidatedRemoveWorkflowStepRequest).validatedRemoveWorkflowStep = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    recordVersion: body.recordVersion,
    reason: body.reason,
  };
}

export function validateAddStepChecklistRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as AddStepChecklistHttpBody;
  (req as ValidatedAddStepChecklistRequest).validatedAddStepChecklist = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    recordVersion: body.recordVersion,
    reason: body.reason,
    checklist: body,
  };
}

export function validateRemoveStepChecklistRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = (req.body ?? {}) as OptionalOccBody;
  (req as ValidatedRemoveStepChecklistRequest).validatedRemoveStepChecklist = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    checklistId: requirePathParam(req, 'checklistId'),
    recordVersion: body.recordVersion,
    reason: body.reason,
  };
}

export function validateAssignChecklistRequest(req: LambdaRequest): void {
  const ctx = orgAndActor(req);
  const body = req.body as AssignChecklistHttpBody;
  (req as ValidatedAssignChecklistRequest).validatedAssignChecklist = {
    ...ctx,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: requirePathParam(req, 'stepId'),
    checklistId: requirePathParam(req, 'checklistId'),
    recordVersion: body.recordVersion,
    assigneeType: body.assigneeType,
    assigneeId: body.assigneeId,
    reason: body.reason,
  };
}
