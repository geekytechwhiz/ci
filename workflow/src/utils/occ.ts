import { BaseError } from '@api-hub/utils';
import { WorkflowDefinitionPreconditionRequiredError } from '@api-hub/workflow-runtime-core';

/**
 * Parse OCC expected `recordVersion` from `If-Match` and/or body (rest-api.md).
 * - Missing → 428 PRECONDITION_REQUIRED
 * - Both present but disagree → 400 VALIDATION_ERROR
 */
export function resolveExpectedRecordVersion(input: {
  ifMatchHeader: string | undefined;
  bodyRecordVersion: number | undefined;
}): number {
  const fromHeader = parseIfMatchRecordVersion(input.ifMatchHeader);
  const fromBody =
    typeof input.bodyRecordVersion === 'number' ? input.bodyRecordVersion : undefined;

  if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody) {
    throw new BaseError(
      'If-Match and body recordVersion must agree',
      400,
      'VALIDATION_ERROR',
      [
        {
          field: 'recordVersion',
          message: 'If-Match and body recordVersion must agree',
        },
      ],
      { retryable: false },
    );
  }

  const expected = fromHeader ?? fromBody;
  if (expected === undefined) {
    throw new WorkflowDefinitionPreconditionRequiredError(
      'If-Match or body recordVersion is required for this mutation',
    );
  }

  if (!Number.isInteger(expected) || expected < 1) {
    throw new BaseError(
      'recordVersion must be a positive integer',
      400,
      'VALIDATION_ERROR',
      [{ field: 'recordVersion', message: 'recordVersion must be a positive integer' }],
      { retryable: false },
    );
  }

  return expected;
}

/** Accepts `W/"12"`, `W/12`, `"12"`, or `12`. */
export function parseIfMatchRecordVersion(header: string | undefined): number | undefined {
  if (!header?.trim()) {
    return undefined;
  }
  const raw = header.trim();
  const weak = /^W\/"?(\d+)"?$/i.exec(raw);
  if (weak) {
    return Number(weak[1]);
  }
  const quoted = /^"(\d+)"$/.exec(raw);
  if (quoted) {
    return Number(quoted[1]);
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  throw new BaseError(
    'Invalid If-Match header',
    400,
    'VALIDATION_ERROR',
    [{ field: 'If-Match', message: 'Expected weak ETag form W/"<recordVersion>"' }],
    { retryable: false },
  );
}

export function readHeader(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) {
      return value;
    }
  }
  return undefined;
}

export function weakEtag(recordVersion: number): string {
  return `W/"${recordVersion}"`;
}
