import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  WorkflowEngineConflictError,
  WorkflowEngineNotFoundError,
  WorkflowEnginePreconditionError,
  WorkflowEngineValidationError,
} from '@api-hub/workflow-runtime-core';

import {
  authHeaders,
  baseEvent,
  setupHandlerTestEnv,
  testLambdaContext,
} from '../../__tests__/handler-test-utils';
import { resetWorkflowRuntimeHttpControllerForTests } from '../../controllers/workflow-runtime-http.controller';

jest.mock('@api-hub/middleware', () => {
  const { ApiResponse } = jest.requireActual<typeof import('@api-hub/utils')>(
    '@api-hub/utils',
  );

  function tryParseJson(body: unknown): unknown {
    if (typeof body !== 'string') return body;
    if (body.trim() === '') return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return Symbol.for('invalid-json');
    }
  }

  return {
    withApiHandler:
      (options: any, handler: (req: any) => Promise<any>) =>
      async (event: any) => {
        const parsedBody = tryParseJson(event?.body);
        if (parsedBody === Symbol.for('invalid-json')) {
          return ApiResponse.badRequest(
            { title: 'INVALID_JSON', description: 'Invalid JSON body', severity: 'ERROR' },
            { correlationId: 'test-correlation-id' },
            { code: 'INVALID_JSON' },
          );
        }

        const authHeader = event?.headers?.Authorization ?? event?.headers?.authorization;
        const req = {
          event,
          params: event?.queryStringParameters ?? {},
          body: parsedBody,
          query: {},
          pathParameters: event?.pathParameters ?? undefined,
          context: {
            correlationId: 'test-correlation-id',
            awsRequestId: 'test-aws-request-id',
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
            authHeader,
          },
        };

        try {
          if (options?.bodySchema) {
            req.body = options.bodySchema.parse(req.body);
          }
          if (options?.validator) {
            await options.validator(req);
          }
          const out = await handler(req);
          if (out && typeof out === 'object' && 'statusCode' in out && 'body' in out) {
            return out;
          }
          return ApiResponse.ok(
            out,
            {
              title: 'SUCCESS',
              description: 'Request processed successfully',
              severity: 'SUCCESS',
            },
            { correlationId: 'test-correlation-id' },
          );
        } catch (e: any) {
          if (e?.name === 'ZodError') {
            return ApiResponse.badRequest(
              {
                title: 'VALIDATION_ERROR',
                description: e?.issues?.[0]?.message ?? 'Validation failed',
                severity: 'ERROR',
              },
              { correlationId: 'test-correlation-id' },
              { code: 'VALIDATION_ERROR' },
            );
          }
          const statusCode = e?.statusCode ?? 500;
          const code = e?.code ?? 'INTERNAL_ERROR';
          return ApiResponse.error(
            statusCode,
            { title: code, description: e?.message ?? 'Error', severity: 'ERROR' },
            { correlationId: 'test-correlation-id' },
            { code, details: e?.details },
          );
        }
      },
  };
});

// eslint-disable-next-line no-var
var mockEngine: Record<string, jest.Mock>;

jest.mock('@api-hub/workflow-runtime-core', () => {
  const actual = jest.requireActual<typeof import('@api-hub/workflow-runtime-core')>(
    '@api-hub/workflow-runtime-core',
  );
  mockEngine = {
    create: jest.fn(),
    start: jest.fn(),
    assign: jest.fn(),
    wait: jest.fn(),
    block: jest.fn(),
    resume: jest.fn(),
    complete: jest.fn(),
    cancel: jest.fn(),
    startStep: jest.fn(),
    completeStep: jest.fn(),
    skipStep: jest.fn(),
    waitStep: jest.fn(),
    blockStep: jest.fn(),
    resumeStep: jest.fn(),
    deferStep: jest.fn(),
    cancelStep: jest.fn(),
    assignStep: jest.fn(),
  };
  return {
    ...actual,
    WorkflowEngineService: jest.fn().mockImplementation(() => mockEngine),
  };
});

import { main as createMain } from './createWorkflow';
import { main as startMain } from './startWorkflow';
import { main as assignMain } from './assignWorkflow';
import { main as waitMain } from './waitWorkflow';
import { main as blockMain } from './blockWorkflow';
import { main as resumeMain } from './resumeWorkflow';
import { main as completeMain } from './completeWorkflow';
import { main as cancelMain } from './cancelWorkflow';
import { main as startStepMain } from './startStep';
import { main as completeStepMain } from './completeStep';
import { main as skipStepMain } from './skipStep';
import { main as waitStepMain } from './waitStep';
import { main as blockStepMain } from './blockStep';
import { main as resumeStepMain } from './resumeStep';
import { main as deferStepMain } from './deferStep';
import { main as cancelStepMain } from './cancelStep';
import { main as assignStepMain } from './assignStep';

function sampleWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    workflowId: 'wf-1',
    workflowType: 'FORMAL_REVIEW',
    definitionVersion: '0000000001',
    patientId: 'pat-1',
    carePlanId: 'cp-1',
    contextKey: 'ctx-1',
    workflowStatus: 'inProgress',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    recordVersion: 2,
    ...overrides,
  };
}

function sampleStep(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    workflowId: 'wf-1',
    stepId: 'step-1',
    name: 'Review',
    stepStatus: 'inProgress',
    sortOrder: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    recordVersion: 3,
    ...overrides,
  };
}

function idemHeaders(extra: Record<string, string> = {}) {
  return authHeaders({
    'Idempotency-Key': 'idem-key-1',
    'If-Match': 'W/"1"',
    ...extra,
  });
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    workflowType: 'FORMAL_REVIEW',
    patientId: 'pat-1',
    carePlanId: 'cp-1',
    carePlanTemplateId: 'cpt-1',
    contextKey: 'review-2026-Q3',
    autoStart: true,
    ...overrides,
  };
}

describe('workflow runtime command HTTP handlers (WR-08b)', () => {
  let envCleanup: () => void;

  beforeAll(() => {
    envCleanup = setupHandlerTestEnv().restore;
  });

  afterAll(() => {
    envCleanup();
  });

  beforeEach(() => {
    resetWorkflowRuntimeHttpControllerForTests();
    Object.values(mockEngine).forEach((fn) => {
      fn.mockReset();
    });
  });

  it('create workflow → 201 and forwards idempotency key', async () => {
    mockEngine.create.mockResolvedValue({
      workflow: sampleWorkflow({ recordVersion: 1, workflowStatus: 'inProgress' }),
      replayed: false,
    });
    const res = await createMain(
      baseEvent({
        headers: authHeaders({ 'Idempotency-Key': 'create-1' }),
        body: JSON.stringify(createBody()),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body).data;
    expect(data.workflowId).toBe('wf-1');
    expect(data.pk).toBeUndefined();
    expect(res.headers?.ETag).toBe('W/"1"');
    expect(mockEngine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        createdBy: 'user-1',
        carePlanTemplateId: 'cpt-1',
        idempotencyKey: 'create-1',
        idempotencyScope: 'http',
        idempotencyPayload: expect.objectContaining({
          carePlanTemplateId: 'cpt-1',
          workflowStage: null,
        }),
      }),
    );
  });

  it('create workflow → forwards carePlanTemplateId and workflowStage', async () => {
    mockEngine.create.mockResolvedValue({
      workflow: sampleWorkflow({
        recordVersion: 1,
        workflowStatus: 'inProgress',
        sourceTemplateId: 'tmpl-1',
        carePlanTemplateId: 'cpt-1',
        workflowStage: 'PATIENT_ONBOARDING',
      }),
      replayed: false,
    });
    const res = await createMain(
      baseEvent({
        headers: authHeaders({ 'Idempotency-Key': 'create-tmpl-1' }),
        body: JSON.stringify(
          createBody({
            workflowType: 'PATIENT_ONBOARDING',
            carePlanTemplateId: 'cpt-1',
            workflowStage: 'PATIENT_ONBOARDING',
          }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    expect(mockEngine.create).toHaveBeenCalledWith(
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

  it('create rejects missing carePlanTemplateId', async () => {
    const res = await createMain(
      baseEvent({
        headers: authHeaders({ 'Idempotency-Key': 'create-bad' }),
        body: JSON.stringify(
          createBody({ carePlanTemplateId: undefined }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockEngine.create).not.toHaveBeenCalled();
  });

  it('create rejects invalid workflowStage', async () => {
    const res = await createMain(
      baseEvent({
        headers: authHeaders({ 'Idempotency-Key': 'create-stage' }),
        body: JSON.stringify(
          createBody({
            carePlanTemplateId: 'cpt-1',
            workflowStage: 'notAStage',
          }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockEngine.create).not.toHaveBeenCalled();
  });

  it('create maps missing mapping/template engine errors', async () => {
    mockEngine.create.mockRejectedValue(
      new WorkflowEngineNotFoundError(
        'Care plan mapping not found',
        'CAREPLAN_MAPPING_NOT_FOUND',
      ),
    );
    const res = await createMain(
      baseEvent({
        headers: authHeaders({ 'Idempotency-Key': 'create-map' }),
        body: JSON.stringify(
          createBody({
            carePlanTemplateId: 'cpt-1',
            workflowStage: 'FORMAL_REVIEW',
          }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('CAREPLAN_MAPPING_NOT_FOUND');
  });

  it('create rejects missing Idempotency-Key', async () => {
    const res = await createMain(
      baseEvent({ body: JSON.stringify(createBody()) }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockEngine.create).not.toHaveBeenCalled();
  });

  it('start → 200 with OCC + idempotency forwarded', async () => {
    mockEngine.start.mockResolvedValue({
      workflow: sampleWorkflow(),
      recordVersion: 2,
    });
    const res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockEngine.start).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        ifMatch: 'W/"1"',
        idempotencyKey: 'idem-key-1',
        actorId: 'user-1',
      }),
    );
  });

  it('start missing If-Match maps engine 428', async () => {
    mockEngine.start.mockRejectedValue(new WorkflowEnginePreconditionError());
    const res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders({ 'Idempotency-Key': 'k' }),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(428);
    expect(JSON.parse(res.body).error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('assign → 200', async () => {
    mockEngine.assign.mockResolvedValue({
      workflow: sampleWorkflow({ assigneeId: 'usr-2' }),
      recordVersion: 3,
    });
    const res = await assignMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({
          assigneeType: 'user',
          assigneeId: 'usr-2',
          reason: 'reassign',
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockEngine.assign).toHaveBeenCalled();
  });

  it('wait / block require reason', async () => {
    const waitRes = await waitMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(waitRes.statusCode).toBe(400);

    mockEngine.block.mockResolvedValue({
      workflow: sampleWorkflow({ workflowStatus: 'blocked' }),
      recordVersion: 2,
    });
    const blockRes = await blockMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: JSON.stringify({ reason: 'need labs' }),
      }),
      testLambdaContext(),
    );
    expect(blockRes.statusCode).toBe(200);
  });

  it('resume → 200', async () => {
    mockEngine.resume.mockResolvedValue({
      workflow: sampleWorkflow(),
      recordVersion: 4,
    });
    const res = await resumeMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders({ 'If-Match': 'W/"3"' }),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
  });

  it('complete → 200 with completionSummary', async () => {
    mockEngine.complete.mockResolvedValue({
      workflow: sampleWorkflow({ workflowStatus: 'completed' }),
      recordVersion: 5,
      completionSummary: { outcome: 'completed' },
    });
    const res = await completeMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({ outcome: 'completed', finalNote: 'ok' }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.completionSummary).toEqual({ outcome: 'completed' });
  });

  it('complete rejects free-form outcome (approved)', async () => {
    const res = await completeMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({ outcome: 'approved', finalNote: 'ok' }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockEngine.complete).not.toHaveBeenCalled();
  });

  it('cancel requires reason + maps VERSION_CONFLICT', async () => {
    const missing = await cancelMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(missing.statusCode).toBe(400);

    mockEngine.cancel.mockRejectedValue(
      new WorkflowEngineConflictError('stale', 'VERSION_CONFLICT'),
    );
    const conflict = await cancelMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({ reason: 'abort' }),
      }),
      testLambdaContext(),
    );
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body).error.code).toBe('VERSION_CONFLICT');
  });

  it('maps UNIQUENESS_CONFLICT / IDEMPOTENCY_CONFLICT / TERMINAL_WORKFLOW / INVALID_TRANSITION', async () => {
    mockEngine.start.mockRejectedValueOnce(
      new WorkflowEngineConflictError('dup', 'UNIQUENESS_CONFLICT'),
    );
    let res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('UNIQUENESS_CONFLICT');

    mockEngine.start.mockRejectedValueOnce(
      new WorkflowEngineConflictError('idem', 'IDEMPOTENCY_CONFLICT'),
    );
    res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('IDEMPOTENCY_CONFLICT');

    mockEngine.start.mockRejectedValueOnce(
      new WorkflowEngineConflictError('done', 'TERMINAL_WORKFLOW'),
    );
    res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('TERMINAL_WORKFLOW');

    mockEngine.start.mockRejectedValueOnce(
      new WorkflowEngineConflictError('bad', 'INVALID_TRANSITION'),
    );
    res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('INVALID_TRANSITION');
  });

  it('maps not found and validation errors', async () => {
    mockEngine.start.mockRejectedValue(new WorkflowEngineNotFoundError());
    let res = await startMain(
      baseEvent({
        pathParameters: { workflowId: 'missing' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(404);

    mockEngine.complete.mockRejectedValue(
      new WorkflowEngineValidationError('incomplete', [
        { code: 'MISSING_REQUIREMENTS', message: 'step open' },
      ]),
    );
    res = await completeMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: idemHeaders(),
        body: JSON.stringify({ outcome: 'completed' }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(422);
  });

  const stepCases: Array<{
    name: string;
    main: (e: APIGatewayProxyEvent, c: unknown) => Promise<any>;
    mockKey: string;
    body: Record<string, unknown>;
  }> = [
    { name: 'start', main: startStepMain, mockKey: 'startStep', body: {} },
    { name: 'complete', main: completeStepMain, mockKey: 'completeStep', body: {} },
    {
      name: 'skip',
      main: skipStepMain,
      mockKey: 'skipStep',
      body: { reason: 'n/a' },
    },
    {
      name: 'wait',
      main: waitStepMain,
      mockKey: 'waitStep',
      body: { reason: 'pending' },
    },
    {
      name: 'block',
      main: blockStepMain,
      mockKey: 'blockStep',
      body: { reason: 'blocked' },
    },
    { name: 'resume', main: resumeStepMain, mockKey: 'resumeStep', body: {} },
    {
      name: 'defer',
      main: deferStepMain,
      mockKey: 'deferStep',
      body: { reason: 'later' },
    },
    {
      name: 'cancel',
      main: cancelStepMain,
      mockKey: 'cancelStep',
      body: { reason: 'stop' },
    },
  ];

  it.each(stepCases)('step $name → 200 and invokes engine', async ({ main, mockKey, body }) => {
    mockEngine[mockKey].mockResolvedValue({
      step: sampleStep(),
      recordVersion: 3,
    });
    const res = await main(
      baseEvent({
        pathParameters: { workflowId: 'wf-1', stepId: 'step-1' },
        headers: idemHeaders(),
        body: JSON.stringify(body),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.stepId).toBe('step-1');
    expect(mockEngine[mockKey]).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        stepId: 'step-1',
        ifMatch: 'W/"1"',
        idempotencyKey: 'idem-key-1',
      }),
    );
  });

  it('step assign is OCC-only (no idempotency key required)', async () => {
    mockEngine.assignStep.mockResolvedValue({
      step: sampleStep({ assigneeId: 'usr-9' }),
      recordVersion: 4,
    });
    const res = await assignStepMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1', stepId: 'step-1' },
        headers: authHeaders({ 'If-Match': 'W/"3"' }),
        body: JSON.stringify({
          assigneeType: 'user',
          assigneeId: 'usr-9',
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockEngine.assignStep).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: 'usr-9',
        ifMatch: 'W/"3"',
      }),
    );
    expect(mockEngine.assignStep.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('step skip requires reason', async () => {
    const res = await skipStepMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1', stepId: 'step-1' },
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
  });
});
