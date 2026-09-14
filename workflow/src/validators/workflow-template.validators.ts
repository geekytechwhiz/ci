import {
  InternalServiceAuthError,
  matchesInternalServiceBearer,
} from '@api-hub/service-clients';
import {
  BaseError,
  CATALOG_VALUE_CODE_PATTERN,
  type LambdaRequest,
} from '@api-hub/utils';
import {
  TEMPLATE_SCOPE,
  WORKFLOW_LIST_DEFAULT_LIMIT,
  WORKFLOW_LIST_MAX_LIMIT,
  WORKFLOW_STAGES,
  WORKFLOW_TEMPLATE_METADATA_FIELDS,
  WORKFLOW_TYPES,
  type TemplateScope,
  type TemplateStatus,
  type WorkflowTemplateCatalogMetadata,
  type WorkflowStage,
} from '@api-hub/workflow-runtime-core';

import {
  getActorUserIdForRequest,
  getOrganizationIdForRequest,
} from '../utils/helpers';
import { readHeader, resolveExpectedRecordVersion } from '../utils/occ';
import {
  MAX_WORKFLOW_TEMPLATE_STEPS,
  templateStatusQuerySchema,
  workflowStageSchema,
  workflowTypeSchema,
  type CloneOrgWorkflowTemplatesForCarePlanHttpBody,
  type CloneWorkflowTemplateHttpBody,
  type CreateWorkflowTemplateHttpBody,
  type DeleteCarePlanWorkflowMappingHttpBody,
  type InactivateWorkflowTemplateHttpBody,
  type PublishMappedOrgWorkflowTemplatesHttpBody,
  type PublishWorkflowTemplateHttpBody,
  type PutCarePlanWorkflowMappingsHttpBody,
  type UpdateWorkflowTemplateHttpBody,
} from './workflow-template.schemas';

function unauthorizedOrg(): never {
  throw new BaseError(
    'Organization could not be resolved from the access token',
    401,
    'UNAUTHORIZED',
    [{ message: 'Organization could not be resolved from the access token' }],
    { retryable: false },
  );
}

function forbiddenOrgMismatch(): never {
  throw new BaseError(
    'Path organizationId does not match the access token organization',
    403,
    'FORBIDDEN',
    [{ field: 'orgId', message: 'Organization mismatch' }],
    { retryable: false },
  );
}

export function requirePathParam(req: LambdaRequest, name: string): string {
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

/** steps.length ∈ 1..MAX → else 422 MAX_STEPS_EXCEEDED */
export function assertTemplateStepCount(steps: unknown[] | undefined): void {
  const length = Array.isArray(steps) ? steps.length : 0;
  if (length < 1 || length > MAX_WORKFLOW_TEMPLATE_STEPS) {
    throw new BaseError(
      `A workflow template may have between 1 and ${MAX_WORKFLOW_TEMPLATE_STEPS} steps`,
      422,
      'MAX_STEPS_EXCEEDED',
      [
        {
          field: 'steps',
          code: 'MAX_STEPS_EXCEEDED',
          message: `steps.length must be between 1 and ${MAX_WORKFLOW_TEMPLATE_STEPS}`,
        },
      ],
      { retryable: false },
    );
  }
}

/**
 * Catalog metadata list filters. Values are Metadata Registry value codes, so a
 * malformed filter is a client error rather than an empty result set.
 */
function parseCatalogMetadataFilters(
  query: Record<string, string | undefined>,
): WorkflowTemplateCatalogMetadata {
  const filters: WorkflowTemplateCatalogMetadata = {};
  for (const field of WORKFLOW_TEMPLATE_METADATA_FIELDS) {
    const raw = query[field]?.trim();
    if (!raw) {
      continue;
    }
    if (!CATALOG_VALUE_CODE_PATTERN.test(raw)) {
      throw new BaseError(
        `Invalid ${field}`,
        400,
        'VALIDATION_ERROR',
        [
          {
            field,
            message: 'Must be a metadata value code (e.g. CHRONIC)',
          },
        ],
        { retryable: false },
      );
    }
    filters[field] = raw;
  }
  return filters;
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
      [
        {
          field: 'limit',
          message: `limit must be between 1 and ${WORKFLOW_LIST_MAX_LIMIT}`,
        },
      ],
      { retryable: false },
    );
  }
  return n;
}

function resolveOrgScope(
  req: LambdaRequest,
): { organizationId: string; userId?: string } {
  const tokenOrgId = getOrganizationIdForRequest(
    req.event,
    req.context.authHeader,
  );
  if (!tokenOrgId) unauthorizedOrg();
  const pathOrgId = requirePathParam(req, 'orgId');
  if (pathOrgId !== tokenOrgId) forbiddenOrgMismatch();
  return {
    organizationId: pathOrgId,
    userId: getActorUserIdForRequest(req.event, req.context.authHeader),
  };
}

const INTERNAL_SERVICE_ACTOR_ID = 'system:internal-service';

function readAuthHeader(req: LambdaRequest): string | undefined {
  return (
    req.context.authHeader ||
    req.event.headers?.Authorization ||
    req.event.headers?.authorization
  );
}

/**
 * JWT org-scope, or INTERNAL_SERVICE_TOKEN (Template Service enablement S2S).
 * Path orgId is the tenant for S2S — same pattern as Template T2/T6/T7.
 */
async function resolveOrgScopeOrInternalService(
  req: LambdaRequest,
): Promise<{ organizationId: string; userId?: string }> {
  const authHeader = readAuthHeader(req);
  try {
    if (await matchesInternalServiceBearer(authHeader)) {
      return {
        organizationId: requirePathParam(req, 'orgId'),
        userId: INTERNAL_SERVICE_ACTOR_ID,
      };
    }
  } catch (err) {
    if (!(err instanceof InternalServiceAuthError)) {
      throw err;
    }
    // Token store unavailable: keep JWT org-scope for Org Admin mapping APIs.
  }
  return resolveOrgScope(req);
}

function resolvePlatformActor(req: LambdaRequest): { userId?: string } {
  return {
    userId: getActorUserIdForRequest(req.event, req.context.authHeader),
  };
}

export type ValidatedCreateWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  userId?: string;
  body: CreateWorkflowTemplateHttpBody;
};

export type ValidatedUpdateWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  userId?: string;
  templateId: string;
  expectedRecordVersion: number;
  body: UpdateWorkflowTemplateHttpBody;
};

export type ValidatedPublishWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  userId?: string;
  templateId: string;
  expectedRecordVersion: number;
};

export type ValidatedInactivateWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  userId?: string;
  templateId: string;
  expectedRecordVersion: number;
};

export type ValidatedCloneWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  userId?: string;
  templateId: string;
  body: CloneWorkflowTemplateHttpBody;
};

export type ValidatedGetWorkflowTemplate = {
  scope: TemplateScope;
  organizationId?: string;
  templateId: string;
};

export type ValidatedListWorkflowTemplateHistory = {
  scope: TemplateScope;
  organizationId?: string;
  templateId: string;
  limit: number;
  cursor?: string;
};

export type ValidatedListWorkflowTemplates = WorkflowTemplateCatalogMetadata & {
  scope: TemplateScope;
  organizationId?: string;
  templateId?: string;
  workflowStage?: WorkflowStage | string;
  workflowType?: string;
  status?: TemplateStatus | string;
  program?: string;
  condition?: string;
  basedOn?: string;
  limit: number;
  cursor?: string;
};

export type ValidatedGetCarePlanWorkflowMappings = {
  organizationId: string;
  carePlanTemplateId: string;
};

export type ValidatedPutCarePlanWorkflowMappings = {
  organizationId: string;
  userId?: string;
  carePlanTemplateId: string;
  body: PutCarePlanWorkflowMappingsHttpBody;
};

export type ValidatedDeleteCarePlanWorkflowMapping = {
  organizationId: string;
  carePlanTemplateId: string;
  workflowStage: string;
  expectedRecordVersion?: number;
};

export type ValidatedEnsureOrgWorkflowTemplatesFromPlatform = {
  organizationId: string;
  userId?: string;
  body: PutCarePlanWorkflowMappingsHttpBody;
};

export type ValidatedCloneOrgWorkflowTemplatesForCarePlan = {
  organizationId: string;
  userId?: string;
  body: CloneOrgWorkflowTemplatesForCarePlanHttpBody;
};

export type ValidatedPublishMappedOrgWorkflowTemplates = {
  organizationId: string;
  userId?: string;
  body: PublishMappedOrgWorkflowTemplatesHttpBody;
};

export type ValidatedCreateWorkflowTemplateRequest = LambdaRequest & {
  validatedCreateWorkflowTemplate: ValidatedCreateWorkflowTemplate;
};
export type ValidatedUpdateWorkflowTemplateRequest = LambdaRequest & {
  validatedUpdateWorkflowTemplate: ValidatedUpdateWorkflowTemplate;
};
export type ValidatedPublishWorkflowTemplateRequest = LambdaRequest & {
  validatedPublishWorkflowTemplate: ValidatedPublishWorkflowTemplate;
};
export type ValidatedInactivateWorkflowTemplateRequest = LambdaRequest & {
  validatedInactivateWorkflowTemplate: ValidatedInactivateWorkflowTemplate;
};
export type ValidatedCloneWorkflowTemplateRequest = LambdaRequest & {
  validatedCloneWorkflowTemplate: ValidatedCloneWorkflowTemplate;
};
export type ValidatedGetWorkflowTemplateRequest = LambdaRequest & {
  validatedGetWorkflowTemplate: ValidatedGetWorkflowTemplate;
};
export type ValidatedListWorkflowTemplateHistoryRequest = LambdaRequest & {
  validatedListWorkflowTemplateHistory: ValidatedListWorkflowTemplateHistory;
};
export type ValidatedListWorkflowTemplatesRequest = LambdaRequest & {
  validatedListWorkflowTemplates: ValidatedListWorkflowTemplates;
};
export type ValidatedGetCarePlanWorkflowMappingsRequest = LambdaRequest & {
  validatedGetCarePlanWorkflowMappings: ValidatedGetCarePlanWorkflowMappings;
};
export type ValidatedPutCarePlanWorkflowMappingsRequest = LambdaRequest & {
  validatedPutCarePlanWorkflowMappings: ValidatedPutCarePlanWorkflowMappings;
};
export type ValidatedDeleteCarePlanWorkflowMappingRequest = LambdaRequest & {
  validatedDeleteCarePlanWorkflowMapping: ValidatedDeleteCarePlanWorkflowMapping;
};
export type ValidatedEnsureOrgWorkflowTemplatesFromPlatformRequest = LambdaRequest & {
  validatedEnsureOrgWorkflowTemplatesFromPlatform: ValidatedEnsureOrgWorkflowTemplatesFromPlatform;
};
export type ValidatedCloneOrgWorkflowTemplatesForCarePlanRequest = LambdaRequest & {
  validatedCloneOrgWorkflowTemplatesForCarePlan: ValidatedCloneOrgWorkflowTemplatesForCarePlan;
};
export type ValidatedPublishMappedOrgWorkflowTemplatesRequest = LambdaRequest & {
  validatedPublishMappedOrgWorkflowTemplates: ValidatedPublishMappedOrgWorkflowTemplates;
};

function validateCreate(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const body = req.body as CreateWorkflowTemplateHttpBody;
  assertTemplateStepCount(body.steps);

  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (req as ValidatedCreateWorkflowTemplateRequest).validatedCreateWorkflowTemplate =
    {
      scope,
      organizationId: 'organizationId' in base ? base.organizationId : undefined,
      userId: base.userId,
      body,
    };
}

function validateUpdate(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const body = req.body as UpdateWorkflowTemplateHttpBody;
  assertTemplateStepCount(body.steps);

  const expectedRecordVersion = resolveExpectedRecordVersion({
    ifMatchHeader: readHeader(req.event.headers, 'If-Match'),
    bodyRecordVersion: body.recordVersion,
  });

  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (req as ValidatedUpdateWorkflowTemplateRequest).validatedUpdateWorkflowTemplate =
    {
      scope,
      organizationId: 'organizationId' in base ? base.organizationId : undefined,
      userId: base.userId,
      templateId: requirePathParam(req, 'templateId'),
      expectedRecordVersion,
      body,
    };
}

function validatePublish(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const body = (req.body ?? {}) as PublishWorkflowTemplateHttpBody;
  const expectedRecordVersion = resolveExpectedRecordVersion({
    ifMatchHeader: readHeader(req.event.headers, 'If-Match'),
    bodyRecordVersion: body.recordVersion,
  });
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (req as ValidatedPublishWorkflowTemplateRequest).validatedPublishWorkflowTemplate =
    {
      scope,
      organizationId: 'organizationId' in base ? base.organizationId : undefined,
      userId: base.userId,
      templateId: requirePathParam(req, 'templateId'),
      expectedRecordVersion,
    };
}

function validateInactivate(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const body = (req.body ?? {}) as InactivateWorkflowTemplateHttpBody;
  const expectedRecordVersion = resolveExpectedRecordVersion({
    ifMatchHeader: readHeader(req.event.headers, 'If-Match'),
    bodyRecordVersion: body.recordVersion,
  });
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (
    req as ValidatedInactivateWorkflowTemplateRequest
  ).validatedInactivateWorkflowTemplate = {
    scope,
    organizationId: 'organizationId' in base ? base.organizationId : undefined,
    userId: base.userId,
    templateId: requirePathParam(req, 'templateId'),
    expectedRecordVersion,
  };
}

function validateClone(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const body = (req.body ?? {}) as CloneWorkflowTemplateHttpBody;
  if (body.steps !== undefined) {
    assertTemplateStepCount(body.steps);
  }
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (req as ValidatedCloneWorkflowTemplateRequest).validatedCloneWorkflowTemplate =
    {
      scope,
      organizationId: 'organizationId' in base ? base.organizationId : undefined,
      userId: base.userId,
      templateId: requirePathParam(req, 'templateId'),
      body,
    };
}

function validateGet(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  (req as ValidatedGetWorkflowTemplateRequest).validatedGetWorkflowTemplate = {
    scope,
    organizationId: 'organizationId' in base ? base.organizationId : undefined,
    templateId: requirePathParam(req, 'templateId'),
  };
}

function parseHistoryLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return WORKFLOW_LIST_DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > WORKFLOW_LIST_MAX_LIMIT) {
    throw new BaseError(
      `limit must be an integer between 1 and ${WORKFLOW_LIST_MAX_LIMIT}`,
      400,
      'VALIDATION_ERROR',
      [
        {
          field: 'limit',
          message: `limit must be between 1 and ${WORKFLOW_LIST_MAX_LIMIT}`,
        },
      ],
      { retryable: false },
    );
  }
  return n;
}

function validateListHistory(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  const query = req.event.queryStringParameters ?? {};
  const allowed = new Set(['limit', 'cursor']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      throw new BaseError(
        `Unexpected query parameter: ${key}`,
        400,
        'VALIDATION_ERROR',
        [{ field: key, message: 'Unexpected query parameter' }],
        { retryable: false },
      );
    }
  }

  (
    req as ValidatedListWorkflowTemplateHistoryRequest
  ).validatedListWorkflowTemplateHistory = {
    scope,
    organizationId: 'organizationId' in base ? base.organizationId : undefined,
    templateId: requirePathParam(req, 'templateId'),
    limit: parseHistoryLimit(query.limit ?? undefined),
    cursor: query.cursor?.trim() || undefined,
  };
}

function validateList(
  req: LambdaRequest,
  scope: TemplateScope,
): void {
  const base =
    scope === TEMPLATE_SCOPE.ORGANIZATION
      ? resolveOrgScope(req)
      : resolvePlatformActor(req);

  const query = req.event.queryStringParameters ?? {};

  let workflowStage: string | undefined;
  if (query.workflowStage?.trim()) {
    const parsed = workflowStageSchema.safeParse(query.workflowStage.trim());
    if (!parsed.success) {
      throw new BaseError(
        'Invalid workflowStage',
        400,
        'VALIDATION_ERROR',
        [
          {
            field: 'workflowStage',
            message:
              `Must be one of: ${WORKFLOW_STAGES.join(', ')}`,
          },
        ],
        { retryable: false },
      );
    }
    workflowStage = parsed.data;
  }

  let workflowType: string | undefined;
  if (query.workflowType?.trim()) {
    const parsed = workflowTypeSchema.safeParse(query.workflowType.trim());
    if (!parsed.success) {
      throw new BaseError(
        'Invalid workflowType',
        400,
        'VALIDATION_ERROR',
        [
          {
            field: 'workflowType',
            message:
              `Must be one of: ${WORKFLOW_TYPES.join(', ')}`,
          },
        ],
        { retryable: false },
      );
    }
    workflowType = parsed.data;
  }

  let status: string | undefined;
  if (query.status?.trim()) {
    const parsed = templateStatusQuerySchema.safeParse(query.status.trim());
    if (!parsed.success) {
      throw new BaseError(
        'Invalid status',
        400,
        'VALIDATION_ERROR',
        [
          {
            field: 'status',
            message: 'Must be one of: draft, published, inactive',
          },
        ],
        { retryable: false },
      );
    }
    status = parsed.data;
  }

  (req as ValidatedListWorkflowTemplatesRequest).validatedListWorkflowTemplates =
    {
      scope,
      organizationId: 'organizationId' in base ? base.organizationId : undefined,
      templateId: query.templateId?.trim() || undefined,
      workflowStage,
      workflowType,
      status,
      program: query.program?.trim() || undefined,
      condition: query.condition?.trim() || undefined,
      basedOn: query.basedOn?.trim() || undefined,
      ...parseCatalogMetadataFilters(query),
      limit: parseLimit(query.limit ?? undefined),
      cursor: query.cursor?.trim() || undefined,
    };
}

export const validateCreatePlatformWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateCreate(req, TEMPLATE_SCOPE.PLATFORM);
export const validateCreateOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateCreate(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validateUpdatePlatformWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateUpdate(req, TEMPLATE_SCOPE.PLATFORM);
export const validateUpdateOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateUpdate(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validatePublishPlatformWorkflowTemplateRequest = (req: LambdaRequest) =>
  validatePublish(req, TEMPLATE_SCOPE.PLATFORM);
export const validatePublishOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validatePublish(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validateInactivatePlatformWorkflowTemplateRequest = (
  req: LambdaRequest,
) => validateInactivate(req, TEMPLATE_SCOPE.PLATFORM);
export const validateInactivateOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateInactivate(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validateClonePlatformWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateClone(req, TEMPLATE_SCOPE.PLATFORM);
export const validateCloneOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateClone(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validateGetPlatformWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateGet(req, TEMPLATE_SCOPE.PLATFORM);
export const validateGetOrgWorkflowTemplateRequest = (req: LambdaRequest) =>
  validateGet(req, TEMPLATE_SCOPE.ORGANIZATION);
export const validateListPlatformWorkflowTemplateHistoryRequest = (
  req: LambdaRequest,
) => validateListHistory(req, TEMPLATE_SCOPE.PLATFORM);
export const validateListPlatformWorkflowTemplatesRequest = (req: LambdaRequest) =>
  validateList(req, TEMPLATE_SCOPE.PLATFORM);
export const validateListOrgWorkflowTemplatesRequest = (req: LambdaRequest) =>
  validateList(req, TEMPLATE_SCOPE.ORGANIZATION);

export async function requireInternalServiceActor(
  req: LambdaRequest,
): Promise<{ organizationId: string; userId: string }> {
  const authHeader = readAuthHeader(req);
  try {
    if (await matchesInternalServiceBearer(authHeader)) {
      return {
        organizationId: requirePathParam(req, 'orgId'),
        userId: INTERNAL_SERVICE_ACTOR_ID,
      };
    }
  } catch (err) {
    if (!(err instanceof InternalServiceAuthError)) {
      throw err;
    }
  }
  throw new BaseError(
    'Internal service authentication is required',
    403,
    'FORBIDDEN',
    [{ message: 'INTERNAL_SERVICE_TOKEN is required for this operation' }],
    { retryable: false },
  );
}

export async function validateEnsureOrgWorkflowTemplatesFromPlatformRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (
    req as ValidatedEnsureOrgWorkflowTemplatesFromPlatformRequest
  ).validatedEnsureOrgWorkflowTemplatesFromPlatform = {
    organizationId,
    userId,
    body: req.body as PutCarePlanWorkflowMappingsHttpBody,
  };
}

export async function validateCloneOrgWorkflowTemplatesForCarePlanRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (
    req as ValidatedCloneOrgWorkflowTemplatesForCarePlanRequest
  ).validatedCloneOrgWorkflowTemplatesForCarePlan = {
    organizationId,
    userId,
    body: req.body as CloneOrgWorkflowTemplatesForCarePlanHttpBody,
  };
}

export async function validatePublishMappedOrgWorkflowTemplatesRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await requireInternalServiceActor(req);
  (
    req as ValidatedPublishMappedOrgWorkflowTemplatesRequest
  ).validatedPublishMappedOrgWorkflowTemplates = {
    organizationId,
    userId,
    body: req.body as PublishMappedOrgWorkflowTemplatesHttpBody,
  };
}

export async function validateGetCarePlanWorkflowMappingsRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId } = await resolveOrgScopeOrInternalService(req);
  (
    req as ValidatedGetCarePlanWorkflowMappingsRequest
  ).validatedGetCarePlanWorkflowMappings = {
    organizationId,
    carePlanTemplateId: requirePathParam(req, 'carePlanTemplateId'),
  };
}

export async function validatePutCarePlanWorkflowMappingsRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId, userId } = await resolveOrgScopeOrInternalService(req);
  (
    req as ValidatedPutCarePlanWorkflowMappingsRequest
  ).validatedPutCarePlanWorkflowMappings = {
    organizationId,
    userId,
    carePlanTemplateId: requirePathParam(req, 'carePlanTemplateId'),
    body: req.body as PutCarePlanWorkflowMappingsHttpBody,
  };
}

export async function validateDeleteCarePlanWorkflowMappingRequest(
  req: LambdaRequest,
): Promise<void> {
  const { organizationId } = await resolveOrgScopeOrInternalService(req);
  const body = (req.body ?? {}) as DeleteCarePlanWorkflowMappingHttpBody;
  const workflowStage = requirePathParam(req, 'workflowStage');
  const parsedStage = workflowStageSchema.safeParse(workflowStage);
  if (!parsedStage.success) {
    throw new BaseError(
      'Invalid workflowStage',
      400,
      'VALIDATION_ERROR',
      [
        {
          field: 'workflowStage',
          message:
            `Must be one of: ${WORKFLOW_STAGES.join(', ')}`,
        },
      ],
      { retryable: false },
    );
  }

  let expectedRecordVersion: number | undefined;
  const ifMatch = readHeader(req.event.headers, 'If-Match');
  if (ifMatch || body.recordVersion !== undefined) {
    expectedRecordVersion = resolveExpectedRecordVersion({
      ifMatchHeader: ifMatch,
      bodyRecordVersion: body.recordVersion,
    });
  }

  (
    req as ValidatedDeleteCarePlanWorkflowMappingRequest
  ).validatedDeleteCarePlanWorkflowMapping = {
    organizationId,
    carePlanTemplateId: requirePathParam(req, 'carePlanTemplateId'),
    workflowStage: parsedStage.data,
    expectedRecordVersion,
  };
}
