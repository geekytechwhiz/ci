import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  createLogger,
  serializeError,
  type Logger,
} from '@api-hub/observability';
import {
  WorkflowEngineService,
  type CreateWorkflowResult,
} from '@api-hub/workflow-runtime-core';

import type { CarePlanRuntimeClient } from '../infrastructure/http/care-plan-runtime.client';
import {
  extractEventPayloadFromSqsBody,
  toCreateWorkflowCommand,
} from '../mappers/care-plan-workflow-requested.mapper';
import { carePlanWorkflowRequestedPayloadSchema } from '../validators/care-plan-workflow-requested.schemas';
import { classifyCreateFailure } from './care-plan-workflow-requested.classifier';
import {
  createCarePlanWorkflowRequestedMetrics,
  type CarePlanWorkflowRequestedMetrics,
} from './care-plan-workflow-requested.metrics';
import { resolveInboundCarePlanTemplateId } from './inbound-care-plan-template-id';

 
const MAX_RECEIVE_COUNT = 5;

type LogFields = Record<string, unknown>;

export type CarePlanWorkflowRequestedConsumerDeps = {
  engine?: Pick<WorkflowEngineService, 'create'>;
  logger?: Logger;
  metrics?: CarePlanWorkflowRequestedMetrics;
  
  carePlanRuntimeClient?: CarePlanRuntimeClient;
};

let singleton: CarePlanWorkflowRequestedConsumer | undefined;

 
export function getCarePlanWorkflowRequestedConsumer(
  deps?: CarePlanWorkflowRequestedConsumerDeps,
): CarePlanWorkflowRequestedConsumer {
  if (!singleton) {
    singleton = new CarePlanWorkflowRequestedConsumer(deps);
  }
  return singleton;
}

export function resetCarePlanWorkflowRequestedConsumerForTests(): void {
  singleton = undefined;
}

/**
 * WR-09: inbound EventBridge → SQS consumer for CarePlanWorkflowRequested.v1.
 * Validates envelope/payload, invokes WorkflowEngineService.create() only
 * (idempotency scope=event, key=eventId), and classifies ACK vs Retry.
 *
 * Legacy: if carePlanTemplateId is omitted, resolve via CPR GET template-snapshot.
 */
export class CarePlanWorkflowRequestedConsumer {
  private readonly engine: Pick<WorkflowEngineService, 'create'>;
  private readonly logger: Logger;
  private readonly metrics: CarePlanWorkflowRequestedMetrics;
  private readonly carePlanRuntimeClient?: CarePlanRuntimeClient;

  constructor(deps: CarePlanWorkflowRequestedConsumerDeps = {}) {
    this.engine = deps.engine ?? new WorkflowEngineService();
    this.logger =
      deps.logger ??
      createLogger({ service: 'workflow-service', redactPII: true });
    this.metrics = deps.metrics ?? createCarePlanWorkflowRequestedMetrics();
    this.carePlanRuntimeClient = deps.carePlanRuntimeClient;
  }

  async handleSqsEvent(event: SQSEvent): Promise<SQSBatchResponse> {
    const failures: { itemIdentifier: string }[] = [];

    const records = event.Records ?? [];
    await Promise.all(
      records.map(async (record) => {
        const disposition = await this.processRecord(record);
        if (disposition === 'retry') {
          failures.push({ itemIdentifier: record.messageId });
        }
      }),
    );

    return { batchItemFailures: failures };
  }

  async processRecord(record: SQSRecord): Promise<'ack' | 'retry'> {
    const receiveCount = readApproximateReceiveCount(record);
    const baseLog: LogFields = {
      messageId: record.messageId,
      receiveCount,
    };

    this.logger.info({
      ...baseLog,
      event: 'care_plan_workflow_requested_received',
      message: 'Received CarePlanWorkflowRequested.v1 message',
    });

    let eventId: string | undefined;
    let organizationId: string | undefined;
    let workflowType: string | undefined;

    try {
      const rawPayload = extractEventPayloadFromSqsBody(record.body);
      const parsed = carePlanWorkflowRequestedPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        this.metrics.increment('ValidationFailure');
        const received =
          rawPayload !== null && typeof rawPayload === 'object'
            ? (rawPayload as Record<string, unknown>)
            : undefined;
        this.logger.warn({
          ...baseLog,
          event: 'care_plan_workflow_requested_validation_failure',
          message: 'Payload validation failed — ACK (permanent)',
          issues: parsed.error.issues,
          receivedWorkflowType: received?.workflowType,
          receivedEventType: received?.eventType,
          receivedCarePlanId: received?.carePlanId,
          receivedCarePlanTemplateId: received?.carePlanTemplateId,
        });
        return 'ack';
      }

      const payload = parsed.data;
      eventId = payload.eventId;
      organizationId = payload.organizationId;
      workflowType = payload.workflowType;

      if (!payload.carePlanTemplateId?.trim()) {
        this.logger.info({
          ...baseLog,
          event: 'care_plan_workflow_requested_snapshot_lookup',
          message:
            'carePlanTemplateId missing — resolving via CPR template-snapshot',
          carePlanId: payload.carePlanId,
          eventId,
        });
      }

      const inbound = await resolveInboundCarePlanTemplateId(payload, {
        carePlanRuntimeClient: this.carePlanRuntimeClient,
      });
      if (inbound.usedSnapshotFallback) {
        this.logger.info({
          ...baseLog,
          event: 'care_plan_workflow_requested_snapshot_resolved',
          message: 'Resolved carePlanTemplateId from CPR snapshot',
          carePlanId: payload.carePlanId,
          carePlanTemplateId: inbound.carePlanTemplateId,
          eventId,
        });
      }

      const command = toCreateWorkflowCommand({
        ...payload,
        carePlanTemplateId: inbound.carePlanTemplateId,
      });
      const result = await this.engine.create(command);

      return this.handleCreateSuccess(result, {
        baseLog,
        eventId,
        organizationId,
        workflowType,
      });
    } catch (err) {
      return this.handleCreateFailure(err, {
        baseLog,
        eventId,
        organizationId,
        workflowType,
        receiveCount,
      });
    }
  }

  private handleCreateSuccess(
    result: CreateWorkflowResult,
    ctx: {
      baseLog: LogFields;
      eventId: string;
      organizationId: string;
      workflowType: string;
    },
  ): 'ack' {
    const workflowId = result.workflow.workflowId;

    if (result.replayed) {
      this.metrics.increment('DuplicateEvent');
      this.logger.info({
        ...ctx.baseLog,
        event: 'care_plan_workflow_requested_duplicate_event',
        message: 'Duplicate event — ACK (no create)',
        eventId: ctx.eventId,
        organizationId: ctx.organizationId,
        workflowId,
        workflowType: ctx.workflowType,
      });
      return 'ack';
    }

    this.metrics.increment('WorkflowCreated');
    this.logger.info({
      ...ctx.baseLog,
      event: 'care_plan_workflow_requested_workflow_created',
      message: 'Workflow created from CarePlanWorkflowRequested',
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      workflowId,
      workflowType: ctx.workflowType,
    });
    return 'ack';
  }

  private handleCreateFailure(
    err: unknown,
    ctx: {
      baseLog: LogFields;
      eventId?: string;
      organizationId?: string;
      workflowType?: string;
      receiveCount: number;
    },
  ): 'ack' | 'retry' {
    const classified = classifyCreateFailure(err);
    const baseFields = {
      ...ctx.baseLog,
      eventId: ctx.eventId,
      organizationId: ctx.organizationId,
      workflowType: ctx.workflowType,
      code: classified.code,
      err: serializeError(err),
    };

    if (classified.kind === 'duplicateWorkflow') {
      this.metrics.increment('DuplicateWorkflow');
      this.logger.info({
        ...baseFields,
        event: 'care_plan_workflow_requested_duplicate_workflow',
        message: 'Active workflow already exists — ACK',
      });
      return 'ack';
    }

    if (classified.kind === 'validationFailure') {
      this.metrics.increment('ValidationFailure');
      this.logger.warn({
        ...baseFields,
        event: 'care_plan_workflow_requested_validation_failure',
        message: 'Validation / permanent failure — ACK',
      });
      return 'ack';
    }

    this.metrics.increment('Retry');
    if (ctx.receiveCount >= MAX_RECEIVE_COUNT) {
      this.metrics.increment('DLQ');
      this.logger.error({
        ...baseFields,
        event: 'care_plan_workflow_requested_dlq',
        message: 'Max receives reached — reporting failure for DLQ',
        receiveCount: ctx.receiveCount,
      });
    } else if (classified.kind === 'unexpected') {
      this.logger.error({
        ...baseFields,
        event: 'care_plan_workflow_requested_unexpected_failure',
        message: 'Unexpected failure — retry',
        receiveCount: ctx.receiveCount,
      });
    } else {
      this.logger.warn({
        ...baseFields,
        event: 'care_plan_workflow_requested_retry',
        message: 'Transient failure — retry',
        receiveCount: ctx.receiveCount,
      });
    }

    return 'retry';
  }
}

function readApproximateReceiveCount(record: SQSRecord): number {
  const raw = record.attributes?.ApproximateReceiveCount;
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}
