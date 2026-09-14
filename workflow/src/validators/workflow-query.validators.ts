import { BaseError, type LambdaRequest } from '@api-hub/utils';
import {
  WORKFLOW_LIST_DEFAULT_LIMIT,
  WORKFLOW_LIST_MAX_LIMIT,
  type DashboardQueueName,
} from '@api-hub/workflow-runtime-core';

import { getActorUserIdForRequest, getOrganizationIdForRequest } from '../utils/helpers';

const DASHBOARD_QUEUES = new Set<string>([
  'my',
  'blocked',
  'waiting',
  'overdue',
  'onboardingPending',
  'formalReviewDue',
  'closureReviewDue',
]);

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

function orgContext(req: LambdaRequest): {
  organizationId: string;
  userId?: string;
} {
  const organizationId = getOrganizationIdForRequest(req.event, req.context.authHeader);
  if (!organizationId) unauthorizedOrg();
  return {
    organizationId,
    userId: getActorUserIdForRequest(req.event, req.context.authHeader),
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === null || raw === '') {
    return WORKFLOW_LIST_DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > WORKFLOW_LIST_MAX_LIMIT) {
    throw new BaseError(
      `limit must be an integer between 1 and ${WORKFLOW_LIST_MAX_LIMIT}`,
      400,
      'VALIDATION_ERROR',
      [{ field: 'limit', message: `limit must be between 1 and ${WORKFLOW_LIST_MAX_LIMIT}` }],
      { retryable: false },
    );
  }
  return n;
}

function assertNoExtraQueryParams(
  query: Record<string, string | undefined> | null | undefined,
  allowed: Set<string>,
): void {
  if (!query) return;
  for (const key of Object.keys(query)) {
    if (!allowed.has(key) && query[key] !== undefined && query[key] !== null) {
      throw new BaseError(
        `Unsupported query parameter: ${key}`,
        400,
        'UNSUPPORTED_FILTER',
        [{ field: key, message: `Query parameter '${key}' is not allowed` }],
        { retryable: false },
      );
    }
  }
}

export type IncludeParts = {
  steps: boolean;
  notes: boolean;
  evidence: boolean;
};

export type ValidatedGetWorkflow = {
  organizationId: string;
  workflowId: string;
  include: IncludeParts;
};

export type ValidatedWorkflowIdQuery = {
  organizationId: string;
  workflowId: string;
  limit: number;
  cursor?: string;
  stepId?: string;
};

export type ValidatedListWorkflows = {
  organizationId: string;
  patientId?: string;
  carePlanId?: string;
  workflowType?: string;
  workflowStatus?: string;
  assigneeType?: string;
  assigneeId?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  limit: number;
  cursor?: string;
};

export type ValidatedDashboardQueue = {
  organizationId: string;
  queue: DashboardQueueName;
  assigneeUserId?: string;
  limit: number;
  cursor?: string;
};

export type ValidatedGetWorkflowRequest = LambdaRequest & {
  validatedGetWorkflow: ValidatedGetWorkflow;
};
export type ValidatedListHistoryRequest = LambdaRequest & {
  validatedListHistory: ValidatedWorkflowIdQuery;
};
export type ValidatedListNotesRequest = LambdaRequest & {
  validatedListNotes: ValidatedWorkflowIdQuery;
};
export type ValidatedListEvidenceRequest = LambdaRequest & {
  validatedListEvidence: ValidatedWorkflowIdQuery;
};
export type ValidatedListWorkflowsRequest = LambdaRequest & {
  validatedListWorkflows: ValidatedListWorkflows;
};
export type ValidatedDashboardQueueRequest = LambdaRequest & {
  validatedDashboardQueue: ValidatedDashboardQueue;
};
export type ValidatedWorkbenchRequest = LambdaRequest & {
  validatedWorkbench: { organizationId: string; workflowId: string };
};
export type ValidatedReadinessRequest = LambdaRequest & {
  validatedReadiness: { organizationId: string; workflowId: string };
};

function parseInclude(raw: string | undefined): IncludeParts {
  const parts = new Set(
    (raw ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
  for (const p of parts) {
    if (p !== 'steps' && p !== 'notes' && p !== 'evidence') {
      throw new BaseError(
        `Unsupported include value: ${p}`,
        400,
        'VALIDATION_ERROR',
        [{ field: 'include', message: 'Allowed: steps, notes, evidence' }],
        { retryable: false },
      );
    }
  }
  return {
    steps: parts.has('steps'),
    notes: parts.has('notes'),
    evidence: parts.has('evidence'),
  };
}

export function validateGetWorkflowRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(query, new Set(['include']));
  (req as ValidatedGetWorkflowRequest).validatedGetWorkflow = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
    include: parseInclude(query.include ?? undefined),
  };
}

export function validateListHistoryRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(query, new Set(['limit', 'cursor']));
  (req as ValidatedListHistoryRequest).validatedListHistory = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
    limit: parseLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

export function validateListNotesRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(query, new Set(['limit', 'cursor']));
  (req as ValidatedListNotesRequest).validatedListNotes = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
    limit: parseLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

export function validateListEvidenceRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(query, new Set(['stepId', 'limit', 'cursor']));
  (req as ValidatedListEvidenceRequest).validatedListEvidence = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
    stepId: query.stepId?.trim() || undefined,
    limit: parseLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

export function validateListWorkflowsRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(
    query,
    new Set([
      'patientId',
      'carePlanId',
      'workflowType',
      'workflowStatus',
      'assigneeType',
      'assigneeId',
      'dueBefore',
      'dueAfter',
      'overdue',
      'limit',
      'cursor',
    ]),
  );

  let overdue: boolean | undefined;
  if (query.overdue !== undefined && query.overdue !== null && query.overdue !== '') {
    const v = query.overdue.trim().toLowerCase();
    if (v !== 'true' && v !== 'false' && v !== '1' && v !== '0') {
      throw new BaseError(
        'overdue must be true or false',
        400,
        'VALIDATION_ERROR',
        [{ field: 'overdue', message: 'overdue must be true or false' }],
        { retryable: false },
      );
    }
    overdue = v === 'true' || v === '1';
  }

  (req as ValidatedListWorkflowsRequest).validatedListWorkflows = {
    organizationId,
    patientId: query.patientId?.trim() || undefined,
    carePlanId: query.carePlanId?.trim() || undefined,
    workflowType: query.workflowType?.trim() || undefined,
    workflowStatus: query.workflowStatus?.trim() || undefined,
    assigneeType: query.assigneeType?.trim() || undefined,
    assigneeId: query.assigneeId?.trim() || undefined,
    dueBefore: query.dueBefore?.trim() || undefined,
    dueAfter: query.dueAfter?.trim() || undefined,
    overdue,
    limit: parseLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

export function validateDashboardQueueRequest(req: LambdaRequest): void {
  const { organizationId, userId } = orgContext(req);
  const query = req.event.queryStringParameters ?? {};
  assertNoExtraQueryParams(query, new Set(['queue', 'limit', 'cursor']));

  const queue = query.queue?.trim();
  if (!queue) {
    throw new BaseError(
      'queue query parameter is required',
      400,
      'UNSUPPORTED_FILTER',
      [{ field: 'queue', message: 'queue is required' }],
      { retryable: false },
    );
  }
  if (!DASHBOARD_QUEUES.has(queue)) {
    throw new BaseError(
      `Unknown queue: ${queue}`,
      400,
      'UNSUPPORTED_FILTER',
      [{ field: 'queue', message: `Unknown queue value: ${queue}` }],
      { retryable: false },
    );
  }

  if (queue === 'my' && !userId) {
    throw new BaseError(
      'Authenticated user could not be resolved for queue=my',
      401,
      'UNAUTHORIZED',
      [{ message: 'userId is required for queue=my' }],
      { retryable: false },
    );
  }

  (req as ValidatedDashboardQueueRequest).validatedDashboardQueue = {
    organizationId,
    queue: queue as DashboardQueueName,
    assigneeUserId: queue === 'my' ? userId : undefined,
    limit: parseLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

export function validateWorkbenchRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  assertNoExtraQueryParams(req.event.queryStringParameters, new Set());
  (req as ValidatedWorkbenchRequest).validatedWorkbench = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
  };
}

export function validateReadinessRequest(req: LambdaRequest): void {
  const { organizationId } = orgContext(req);
  assertNoExtraQueryParams(req.event.queryStringParameters, new Set());
  (req as ValidatedReadinessRequest).validatedReadiness = {
    organizationId,
    workflowId: requirePathParam(req, 'workflowId'),
  };
}
