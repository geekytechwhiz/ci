import {
  IDEMPOTENCY_SCOPE,
  WORKFLOW_TYPE,
  type CreateWorkflowCommand,
} from '@api-hub/workflow-runtime-core';

import type { CarePlanWorkflowRequestedPayload } from '../validators/care-plan-workflow-requested.schemas';

/**
 * Pre-Aug-2026 CPR wire values (camelCase). Canonical contract is Metadata Registry
 * SCREAMING_SNAKE catalog codes — normalize aliases before Zod so mixed deploys
 * and leftover manual EventBridge tests still map to the strict schema.
 */
const LEGACY_WORKFLOW_TYPE_ALIASES: Record<string, string> = {
  patientOnboarding: WORKFLOW_TYPE.PATIENT_ONBOARDING,
  formalReview: WORKFLOW_TYPE.FORMAL_REVIEW,
  closureReview: WORKFLOW_TYPE.CLOSURE_REVIEW,
};

/**
 * Unwrap SQS body → domain CarePlanWorkflowRequested payload.
 *
 * Supports:
 * - EventBridge → SQS envelope (`detail`)
 * - event-platform BaseEvent (`detail.payload` + envelope fields)
 * - flat domain payload (manual tests)
 */
export function extractEventPayloadFromSqsBody(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new CarePlanWorkflowRequestedParseError('SQS message body is not valid JSON');
  }

  let candidate = parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const envelope = parsed as Record<string, unknown>;
    const detailType = envelope['detail-type'] ?? envelope.detailType;
    if (
      'detail' in envelope &&
      typeof detailType === 'string' &&
      typeof envelope.source === 'string'
    ) {
      candidate = envelope.detail;
    }
  }

  return unwrapCarePlanWorkflowRequestedDetail(candidate);
}

/**
 * Care-plan-runtime publishes event-platform BaseEvent JSON as EventBridge Detail.
 * Workflow validates a flat domain contract — lift `payload` and fill required fields.
 */
export function unwrapCarePlanWorkflowRequestedDetail(detail: unknown): unknown {
  if (detail === null || typeof detail !== 'object') {
    return detail;
  }

  const outer = detail as Record<string, unknown>;
  const nestedPayload = outer.payload;

  // Flat domain payload (manual EventBridge tests / unit fixtures).
  if (
    nestedPayload === undefined ||
    nestedPayload === null ||
    typeof nestedPayload !== 'object'
  ) {
    return normalizeCarePlanWorkflowRequestedDomainFields(outer);
  }

  const inner = nestedPayload as Record<string, unknown>;
  const meta =
    outer.meta !== null && typeof outer.meta === 'object'
      ? (outer.meta as Record<string, unknown>)
      : {};

  return normalizeCarePlanWorkflowRequestedDomainFields({
    ...inner,
    eventId: nonEmptyString(inner.eventId) ?? nonEmptyString(outer.eventId),
    eventType:
      nonEmptyString(inner.eventType) ??
      nonEmptyString(outer.eventType) ??
      'CarePlanWorkflowRequested.v1',
    eventVersion: normalizeDomainEventVersion(
      inner.eventVersion !== undefined ? inner.eventVersion : outer.eventVersion,
    ),
    timestamp: nonEmptyString(inner.timestamp) ?? nonEmptyString(outer.timestamp),
    correlationId:
      nonEmptyString(inner.correlationId) ?? nonEmptyString(meta.correlationId),
  });
}

/** Normalize legacy workflowType aliases; leave unknown strings for Zod to reject. */
export function normalizeWorkflowTypeWireValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return LEGACY_WORKFLOW_TYPE_ALIASES[trimmed] ?? trimmed;
}

function normalizeCarePlanWorkflowRequestedDomainFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('workflowType' in payload) && !('workflowStage' in payload)) {
    return payload;
  }
  const next = { ...payload };
  if ('workflowType' in next) {
    next.workflowType = normalizeWorkflowTypeWireValue(next.workflowType);
  }
  if ('workflowStage' in next) {
    // Stage codes share the same catalog literals as workflowType.
    next.workflowStage = normalizeWorkflowTypeWireValue(next.workflowStage);
  }
  return next;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Domain contract accepts `1` | `"1"`; platform envelope uses `"1.0.0"`. */
function normalizeDomainEventVersion(value: unknown): unknown {
  if (value === '1.0.0') {
    return 1;
  }
  return value;
}

export class CarePlanWorkflowRequestedParseError extends Error {
  readonly code = 'MALFORMED_PAYLOAD';

  constructor(message: string) {
    super(message);
    this.name = 'CarePlanWorkflowRequestedParseError';
  }
}

export type CarePlanWorkflowRequestedCreatePayload =
  CarePlanWorkflowRequestedPayload & {
    /** Required after optional event field + temporary snapshot resolution. */
    carePlanTemplateId: string;
  };

/** Map validated (+ enriched) event payload → WorkflowEngineService.create command. */
export function toCreateWorkflowCommand(
  payload: CarePlanWorkflowRequestedCreatePayload,
): CreateWorkflowCommand {
  const contextKey = payload.contextKey ?? 'default';
  const autoStart = payload.autoStart ?? true;
  const carePlanTemplateId = payload.carePlanTemplateId.trim();
  if (!carePlanTemplateId) {
    throw new CarePlanWorkflowRequestedParseError(
      'carePlanTemplateId is required before WorkflowEngineService.create',
    );
  }
  const workflowStage = payload.workflowStage?.trim() || undefined;

  const idempotencyPayload = {
    workflowType: payload.workflowType,
    patientId: payload.patientId,
    carePlanId: payload.carePlanId,
    contextKey,
    carePlanTemplateId,
    workflowStage: workflowStage ?? null,
    assignee: payload.assignee ?? null,
    dueAt: payload.dueAt ?? null,
    autoStart,
  };

  return {
    organizationId: payload.organizationId,
    patientId: payload.patientId,
    carePlanId: payload.carePlanId,
    workflowType: payload.workflowType,
    contextKey,
    carePlanTemplateId,
    workflowStage,
    assignee: payload.assignee,
    dueAt: payload.dueAt,
    autoStart,
    correlationId: payload.correlationId,
    createdBy: payload.requestedBy,
    idempotencyKey: payload.eventId,
    idempotencyScope: IDEMPOTENCY_SCOPE.EVENT,
    idempotencyPayload,
  };
}
