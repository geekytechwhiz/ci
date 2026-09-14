import { ApiResponse, type LambdaRequest } from '@api-hub/utils';

import { weakEtag } from './occ';

const SUCCESS_MESSAGE = {
  title: 'SUCCESS',
  description: 'Request processed successfully',
  severity: 'SUCCESS' as const,
};

const CREATED_MESSAGE = {
  title: 'RESOURCE_CREATED',
  description: 'Resource created successfully',
  severity: 'SUCCESS' as const,
};

function correlationIdOf(req: LambdaRequest): string {
  return req.context.correlationId ?? 'unknown';
}

/** 200 + ETag for definition mutations / reads that expose recordVersion. */
export function okWithEtag<T extends { recordVersion: number }>(
  req: LambdaRequest,
  data: T,
) {
  return ApiResponse.ok(data, SUCCESS_MESSAGE, {
    correlationId: correlationIdOf(req),
    headers: { ETag: weakEtag(data.recordVersion) },
  });
}

/** 201 + ETag for create / clone. */
export function createdWithEtag<T extends { recordVersion: number }>(
  req: LambdaRequest,
  data: T,
) {
  return ApiResponse.created(data, CREATED_MESSAGE, {
    correlationId: correlationIdOf(req),
    headers: { ETag: weakEtag(data.recordVersion) },
  });
}

export function okData<T>(req: LambdaRequest, data: T) {
  return ApiResponse.ok(data, SUCCESS_MESSAGE, {
    correlationId: correlationIdOf(req),
  });
}
