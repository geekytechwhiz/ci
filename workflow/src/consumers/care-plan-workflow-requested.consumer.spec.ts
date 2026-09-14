import type { SQSEvent, SQSRecord } from 'aws-lambda';
import {
  IDEMPOTENCY_SCOPE,
  WorkflowEngineConflictError,
  WorkflowEngineNotFoundError,
  WorkflowEngineValidationError,
} from '@api-hub/workflow-runtime-core';

import {
  CarePlanWorkflowRequestedConsumer,
  resetCarePlanWorkflowRequestedConsumerForTests,
} from './care-plan-workflow-requested.consumer';

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-001',
    eventType: 'CarePlanWorkflowRequested',
    eventVersion: 1,
    timestamp: '2026-07-20T10:00:00.000Z',
    organizationId: 'org-1',
    patientId: 'pat-1',
    carePlanId: 'cp-1',
    workflowType: 'PATIENT_ONBOARDING',
    carePlanTemplateId: 'cpt-1',
    correlationId: 'corr-1',
    contextKey: 'default',
    autoStart: true,
    requestedBy: 'system',
    ...overrides,
  };
}

function eventBridgeBody(detail: Record<string, unknown>): string {
  return JSON.stringify({
    version: '0',
    id: 'eb-1',
    'detail-type': 'CarePlanWorkflowRequested.v1',
    source: 'care-plan-runtime',
    account: '123',
    time: '2026-07-20T10:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail,
  });
}

function sqsRecord(
  body: string,
  opts: { messageId?: string; receiveCount?: string } = {},
): SQSRecord {
  return {
    messageId: opts.messageId ?? 'msg-1',
    receiptHandle: 'rh-1',
    body,
    attributes: {
      ApproximateReceiveCount: opts.receiveCount ?? '1',
      SentTimestamp: '1',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1',
    },
    messageAttributes: {},
    md5OfBody: 'x',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
    awsRegion: 'us-east-1',
  };
}

function sampleWorkflow(workflowId = 'wf-1') {
  return {
    workflowId,
    organizationId: 'org-1',
    workflowType: 'PATIENT_ONBOARDING',
    workflowStatus: 'inProgress',
    patientId: 'pat-1',
    carePlanId: 'cp-1',
    recordVersion: 1,
  };
}

describe('CarePlanWorkflowRequestedConsumer (WR-09)', () => {
  const create = jest.fn();
  const metrics = {
    increment: jest.fn(),
  };
  let consumer: CarePlanWorkflowRequestedConsumer;

  beforeEach(() => {
    resetCarePlanWorkflowRequestedConsumerForTests();
    create.mockReset();
    metrics.increment.mockReset();
    consumer = new CarePlanWorkflowRequestedConsumer({
      engine: { create },
      metrics,
      logger: createNoopLogger(),
    });
  });

  it('successful create → ACK and invokes engine with event idempotency', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-new'),
      replayed: false,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        patientId: 'pat-1',
        carePlanId: 'cp-1',
        workflowType: 'PATIENT_ONBOARDING',
        carePlanTemplateId: 'cpt-1',
        contextKey: 'default',
        autoStart: true,
        createdBy: 'system',
        correlationId: 'corr-1',
        idempotencyKey: 'evt-001',
        idempotencyScope: IDEMPOTENCY_SCOPE.EVENT,
        idempotencyPayload: expect.objectContaining({
          workflowType: 'PATIENT_ONBOARDING',
          patientId: 'pat-1',
          carePlanId: 'cp-1',
          contextKey: 'default',
          carePlanTemplateId: 'cpt-1',
          workflowStage: null,
          autoStart: true,
        }),
      }),
    );
    expect(metrics.increment).toHaveBeenCalledWith('WorkflowCreated');
  });

  it('new event with catalog carePlanTemplateId does not call CPR snapshot', async () => {
    const getTemplateSnapshot = jest.fn();
    consumer = new CarePlanWorkflowRequestedConsumer({
      engine: { create },
      metrics,
      logger: createNoopLogger(),
      carePlanRuntimeClient: { getTemplateSnapshot } as never,
    });
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-direct'),
      replayed: false,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            organizationId: 'ROSEWOOD',
            carePlanId: 'cpi-1',
            carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
            workflowType: 'PATIENT_ONBOARDING',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(getTemplateSnapshot).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'ROSEWOOD',
        carePlanId: 'cpi-1',
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
        workflowType: 'PATIENT_ONBOARDING',
      }),
    );
  });

  it('FORMAL_REVIEW without workflowStage still creates (engine defaults stage from type)', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-formal'),
      replayed: false,
    });

    await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
            workflowType: 'FORMAL_REVIEW',
            workflowStage: undefined,
          }),
        ),
      ),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
        workflowType: 'FORMAL_REVIEW',
      }),
    );
  });

  it('version-shaped carePlanTemplateId is not treated as catalog id', async () => {
    const getTemplateSnapshot = jest.fn();
    consumer = new CarePlanWorkflowRequestedConsumer({
      engine: { create },
      metrics,
      logger: createNoopLogger(),
      carePlanRuntimeClient: { getTemplateSnapshot } as never,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD-V01',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).not.toHaveBeenCalled();
    expect(getTemplateSnapshot).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('forwards carePlanTemplateId and workflowStage to engine', async () => {
    create.mockResolvedValue({
      workflow: {
        ...sampleWorkflow('wf-tmpl'),
        sourceTemplateId: 'tmpl-1',
        carePlanTemplateId: 'cpt-1',
      },
      replayed: false,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            carePlanTemplateId: 'cpt-1',
            workflowStage: 'PATIENT_ONBOARDING',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        carePlanTemplateId: 'cpt-1',
        workflowStage: 'PATIENT_ONBOARDING',
        idempotencyPayload: expect.objectContaining({
          carePlanTemplateId: 'cpt-1',
          workflowStage: 'PATIENT_ONBOARDING',
        }),
      }),
    );
  });

  it('missing carePlanTemplateId → CPR snapshot lookup → create', async () => {
    const getTemplateSnapshot = jest.fn().mockResolvedValue({
      carePlanInstanceId: 'cp-1',
      orgId: 'org-1',
      patientId: 'pat-1',
      orgTemplateId: 'ORG-FROM-SNAPSHOT',
      linkedOrgCarePlanVersionId: 'ORG-FROM-SNAPSHOT-V01',
    });
    consumer = new CarePlanWorkflowRequestedConsumer({
      engine: { create },
      metrics,
      logger: createNoopLogger(),
      carePlanRuntimeClient: { getTemplateSnapshot } as never,
    });
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-snap'),
      replayed: false,
    });

    const { carePlanTemplateId: _omit, ...without } = samplePayload();
    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(without)),
    );

    expect(disposition).toBe('ack');
    expect(getTemplateSnapshot).toHaveBeenCalledWith({
      carePlanInstanceId: 'cp-1',
      includeLinkedTemplates: true,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        carePlanTemplateId: 'ORG-FROM-SNAPSHOT',
      }),
    );
  });

  it('ACK on missing care-plan mapping / template (permanent not-found)', async () => {
    create.mockRejectedValue(
      new WorkflowEngineNotFoundError(
        'Care plan mapping not found',
        'CAREPLAN_MAPPING_NOT_FOUND',
      ),
    );

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            carePlanTemplateId: 'cpt-missing',
            workflowStage: 'PATIENT_ONBOARDING',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('event-platform BaseEvent detail (CPR wire shape) → unwraps payload and creates', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-cpr'),
      replayed: false,
    });

    const baseEventDetail = {
      eventId: 'workflow-req-PATIENT_ONBOARDING-cpi-1-default',
      eventType: 'CarePlanWorkflowRequested.v1',
      eventVersion: '1.0.0',
      timestamp: '2026-07-29T13:19:41.991Z',
      source: 'care-plan-runtime-service',
      idempotencyKey: 'workflow-req-PATIENT_ONBOARDING-cpi-1-default',
      payload: {
        eventId: 'workflow-req-PATIENT_ONBOARDING-cpi-1-default',
        eventVersion: 1,
        timestamp: '2026-07-29T13:19:41.991Z',
        organizationId: 'org-1',
        patientId: 'pat-1',
        carePlanId: 'cpi-1',
        workflowType: 'PATIENT_ONBOARDING',
        carePlanTemplateId: 'cpt-1',
        correlationId: 'corr-1',
        contextKey: 'default',
        causationId: 'activated-cpi-1',
        requestedBy: 'system',
        autoStart: true,
      },
      meta: {
        correlationId: 'corr-1',
        tenantId: 'org-1',
      },
    };

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(baseEventDetail)),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        patientId: 'pat-1',
        carePlanId: 'cpi-1',
        workflowType: 'PATIENT_ONBOARDING',
        correlationId: 'corr-1',
        idempotencyKey: 'workflow-req-PATIENT_ONBOARDING-cpi-1-default',
      }),
    );
    expect(metrics.increment).toHaveBeenCalledWith('WorkflowCreated');
  });

  it('legacy camelCase workflowType patientOnboarding normalizes and creates for CP catalog id', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-legacy'),
      replayed: false,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody({
          eventId: 'workflow-req-patientOnboarding-cpi-cp1-default',
          eventType: 'CarePlanWorkflowRequested.v1',
          eventVersion: '1.0.0',
          timestamp: '2026-07-29T13:19:41.991Z',
          source: 'care-plan-runtime-service',
          payload: {
            eventId: 'workflow-req-patientOnboarding-cpi-cp1-default',
            eventVersion: 1,
            timestamp: '2026-07-29T13:19:41.991Z',
            organizationId: 'org-1',
            patientId: 'pat-1',
            carePlanId: 'cpi-1',
            carePlanTemplateId: 'CP1',
            workflowType: 'patientOnboarding',
            correlationId: 'corr-1',
            contextKey: 'default',
            requestedBy: 'system',
            autoStart: true,
          },
          meta: { correlationId: 'corr-1' },
        }),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        carePlanTemplateId: 'CP1',
        workflowType: 'PATIENT_ONBOARDING',
      }),
    );
    expect(metrics.increment).toHaveBeenCalledWith('WorkflowCreated');
  });

  it('canonical CLOSURE_REVIEW create → engine with closure contextKey', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-closure'),
      replayed: false,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            workflowType: 'CLOSURE_REVIEW',
            carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
            contextKey: 'closure-2026-08-20',
            dueAt: '2026-08-20T00:00:00.000Z',
            causationId: 'closure-due-cpi-1-closure-2026-08-20',
            eventId: 'workflow-req-CLOSURE_REVIEW-cpi-1-closure-2026-08-20',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'CLOSURE_REVIEW',
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
        contextKey: 'closure-2026-08-20',
        autoStart: true,
        idempotencyKey: 'workflow-req-CLOSURE_REVIEW-cpi-1-closure-2026-08-20',
      }),
    );
    expect(metrics.increment).toHaveBeenCalledWith('WorkflowCreated');
  });

  it.each([
    ['formalReview', 'FORMAL_REVIEW', 'CP1'],
    ['closureReview', 'CLOSURE_REVIEW', 'CP2'],
  ] as const)(
    'legacy %s → %s for carePlanTemplateId %s',
    async (legacy, canonical, carePlanTemplateId) => {
      create.mockResolvedValue({
        workflow: sampleWorkflow(`wf-${canonical}`),
        replayed: false,
      });

      const disposition = await consumer.processRecord(
        sqsRecord(
          eventBridgeBody(
            samplePayload({
              workflowType: legacy,
              carePlanTemplateId,
            }),
          ),
        ),
      );

      expect(disposition).toBe('ack');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowType: canonical,
          carePlanTemplateId,
        }),
      );
    },
  );

  it('rejects unknown workflowType (not stage and not legacy alias)', async () => {
    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            workflowType: 'O1A',
          }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('duplicate event (replayed) → ACK, no WorkflowCreated metric', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow('wf-existing'),
      replayed: true,
    });

    const disposition = await consumer.processRecord(
      sqsRecord(JSON.stringify(samplePayload())),
    );

    expect(disposition).toBe('ack');
    expect(create).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith('DuplicateEvent');
    expect(metrics.increment).not.toHaveBeenCalledWith('WorkflowCreated');
  });

  it('uniqueness conflict → ACK (DuplicateWorkflow)', async () => {
    create.mockRejectedValue(
      new WorkflowEngineConflictError(
        'An active workflow already exists for this uniqueness key',
        'UNIQUENESS_CONFLICT',
      ),
    );

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('ack');
    expect(metrics.increment).toHaveBeenCalledWith('DuplicateWorkflow');
  });

  it('validation failure from engine → ACK (not retried)', async () => {
    create.mockRejectedValue(
      new WorkflowEngineValidationError('Invalid workflowType'),
    );

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('ack');
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('missing published template (NOT_FOUND) → ACK', async () => {
    create.mockRejectedValue(
      new WorkflowEngineNotFoundError('No published template'),
    );

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('ack');
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('malformed payload → ACK without calling engine', async () => {
    const disposition = await consumer.processRecord(
      sqsRecord('{not-json'),
    );

    expect(disposition).toBe('ack');
    expect(create).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('missing required fields → ACK without calling engine', async () => {
    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({ patientId: '', carePlanId: undefined }),
        ),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('ValidationFailure');
  });

  it('unsupported workflowType → ACK without calling engine', async () => {
    const disposition = await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(samplePayload({ workflowType: 'unknownType' })),
      ),
    );

    expect(disposition).toBe('ack');
    expect(create).not.toHaveBeenCalled();
  });

  it('VERSION_CONFLICT → retry', async () => {
    create.mockRejectedValue(
      new WorkflowEngineConflictError('OCC race', 'VERSION_CONFLICT'),
    );

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('retry');
    expect(metrics.increment).toHaveBeenCalledWith('Retry');
  });

  it('DynamoDB throttling → retry', async () => {
    const err = new Error('Throughput exceeded');
    err.name = 'ProvisionedThroughputExceededException';
    create.mockRejectedValue(err);

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('retry');
    expect(metrics.increment).toHaveBeenCalledWith('Retry');
  });

  it('unexpected error → retry', async () => {
    create.mockRejectedValue(new Error('boom'));

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload())),
    );

    expect(disposition).toBe('retry');
    expect(metrics.increment).toHaveBeenCalledWith('Retry');
  });

  it('retry at maxReceiveCount emits DLQ metric', async () => {
    create.mockRejectedValue(new Error('transient'));

    const disposition = await consumer.processRecord(
      sqsRecord(eventBridgeBody(samplePayload()), { receiveCount: '5' }),
    );

    expect(disposition).toBe('retry');
    expect(metrics.increment).toHaveBeenCalledWith('Retry');
    expect(metrics.increment).toHaveBeenCalledWith('DLQ');
  });

  it('partial batch failure — only retryable messages reported', async () => {
    create
      .mockResolvedValueOnce({
        workflow: sampleWorkflow('wf-ok'),
        replayed: false,
      })
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(
        new WorkflowEngineValidationError('bad'),
      );

    const event: SQSEvent = {
      Records: [
        sqsRecord(eventBridgeBody(samplePayload({ eventId: 'e1' })), {
          messageId: 'ok',
        }),
        sqsRecord(eventBridgeBody(samplePayload({ eventId: 'e2' })), {
          messageId: 'retry-me',
        }),
        sqsRecord(eventBridgeBody(samplePayload({ eventId: 'e3' })), {
          messageId: 'bad-payload-ack',
        }),
      ],
    };

    const result = await consumer.handleSqsEvent(event);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures).toEqual(
      expect.arrayContaining([{ itemIdentifier: 'retry-me' }]),
    );
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('defaults contextKey and autoStart in engine invocation', async () => {
    create.mockResolvedValue({
      workflow: sampleWorkflow(),
      replayed: false,
    });

    await consumer.processRecord(
      sqsRecord(
        eventBridgeBody(
          samplePayload({
            contextKey: undefined,
            autoStart: undefined,
          }),
        ),
      ),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        contextKey: 'default',
        autoStart: true,
        idempotencyPayload: expect.objectContaining({
          contextKey: 'default',
          autoStart: true,
        }),
      }),
    );
  });
});

function createNoopLogger() {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => createNoopLogger(),
  } as never;
}
