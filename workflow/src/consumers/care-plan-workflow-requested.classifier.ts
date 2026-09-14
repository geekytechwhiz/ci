import { BaseError } from '@api-hub/utils';
import {
  WorkflowEngineConflictError,
  WorkflowEngineNotFoundError,
  WorkflowEngineValidationError,
} from '@api-hub/workflow-runtime-core';
import { ZodError } from 'zod';

import { CarePlanRuntimeHttpError } from '../infrastructure/http/care-plan-runtime.client';
import { CarePlanWorkflowRequestedParseError } from '../mappers/care-plan-workflow-requested.mapper';
import { TemporaryCarePlanTemplateIdResolutionError } from './temporary-care-plan-template-id.resolver';

export type ConsumeDisposition = 'ack' | 'retry';

export type ConsumeFailureKind =
  | 'duplicateWorkflow'
  | 'validationFailure'
  | 'retry'
  | 'unexpected';

export type ClassifiedFailure = {
  disposition: ConsumeDisposition;
  kind: ConsumeFailureKind;
  code?: string;
};

const TRANSIENT_AWS_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'TransactionConflictException',
  'TimeoutError',
  'NetworkingError',
]);

function awsErrorName(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { name?: string; Code?: string; code?: string };
  return e.name || e.Code || (typeof e.code === 'string' ? e.code : undefined);
}

/**
 * Map engine.
 * Permanent: malformed, validation, uniqueness conflict, not-found published def.
 * Retry: VERSION_CONFLICT, Dynamo throttling/unavailable, unexpected/5xx.
 */
export function classifyCreateFailure(err: unknown): ClassifiedFailure {
  if (err instanceof CarePlanWorkflowRequestedParseError || err instanceof ZodError) {
    return { disposition: 'ack', kind: 'validationFailure', code: 'MALFORMED_PAYLOAD' };
  }

  if (err instanceof TemporaryCarePlanTemplateIdResolutionError) {
    return {
      disposition: 'ack',
      kind: 'validationFailure',
      code: err.code,
    };
  }

  if (err instanceof CarePlanRuntimeHttpError) {
    if (err.retryable) {
      return {
        disposition: 'retry',
        kind: 'retry',
        code: `CPR_HTTP_${err.statusCode}`,
      };
    }
    return {
      disposition: 'ack',
      kind: 'validationFailure',
      code: `CPR_HTTP_${err.statusCode}`,
    };
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return { disposition: 'retry', kind: 'retry', code: 'CPR_HTTP_TIMEOUT' };
  }

  if (err instanceof WorkflowEngineValidationError) {
    return {
      disposition: 'ack',
      kind: 'validationFailure',
      code: err.code,
    };
  }

  if (err instanceof WorkflowEngineNotFoundError) {
    return {
      disposition: 'ack',
      kind: 'validationFailure',
      code: err.code,
    };
  }

  if (err instanceof WorkflowEngineConflictError) {
    if (err.code === 'UNIQUENESS_CONFLICT') {
      return {
        disposition: 'ack',
        kind: 'duplicateWorkflow',
        code: err.code,
      };
    }
    if (err.code === 'VERSION_CONFLICT') {
      return { disposition: 'retry', kind: 'retry', code: err.code };
    }
    if (err.code === 'IDEMPOTENCY_CONFLICT') {
      return {
        disposition: 'ack',
        kind: 'validationFailure',
        code: err.code,
      };
    }
    return { disposition: 'ack', kind: 'validationFailure', code: err.code };
  }

  if (err instanceof BaseError) {
    if (err.retryable === true) {
      return { disposition: 'retry', kind: 'retry', code: err.code };
    }
    if (err.retryable === false) {
      return { disposition: 'ack', kind: 'validationFailure', code: err.code };
    }
    if (err.statusCode >= 500) {
      return { disposition: 'retry', kind: 'retry', code: err.code };
    }
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return { disposition: 'ack', kind: 'validationFailure', code: err.code };
    }
  }

  const name = awsErrorName(err);
  if (name && TRANSIENT_AWS_NAMES.has(name)) {
    return { disposition: 'retry', kind: 'retry', code: name };
  }

  return { disposition: 'retry', kind: 'unexpected', code: name };
}
