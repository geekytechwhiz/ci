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
    getChecklist: jest.fn(),
    listChecklist: jest.fn(),
    listChecklistByStep: jest.fn(),
    startChecklist: jest.fn(),
    completeChecklist: jest.fn(),
    skipChecklist: jest.fn(),
    deferChecklist: jest.fn(),
    blockChecklist: jest.fn(),
    resumeChecklist: jest.fn(),
    cancelChecklist: jest.fn(),
    assignChecklist: jest.fn(),
  };
  return {
    ...actual,
    WorkflowEngineService: jest.fn().mockImplementation(() => mockEngine),
  };
});

import { main as getChecklistMain } from './getChecklist';
import { main as listWorkflowChecklistsMain } from './listWorkflowChecklists';
import { main as listStepChecklistsMain } from './listStepChecklists';
import { main as startChecklistMain } from './startChecklist';
import { main as completeChecklistMain } from './completeChecklist';
import { main as skipChecklistMain } from './skipChecklist';
import { main as deferChecklistMain } from './deferChecklist';
import { main as blockChecklistMain } from './blockChecklist';
import { main as resumeChecklistMain } from './resumeChecklist';
import { main as cancelChecklistMain } from './cancelChecklist';
import { main as assignChecklistMain } from './assignChecklist';

function sampleChecklist(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    workflowId: 'wf-1',
    stepId: 'step-1',
    checklistId: 'chk-1',
    itemName: 'Verify labs',
    required: true,
    allowSkip: false,
    allowDefer: true,
    blocksStepCompletion: true,
    linkedAction: { actionCode: 'OPEN_LABS' },
    checklistStatus: 'notStarted',
    active: true,
    sortOrder: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    recordVersion: 2,
    effectiveAssignee: {
      assigneeType: 'user',
      assigneeId: 'usr-1',
      source: 'step',
    },
    ...overrides,
  };
}

function checklistPathParams(overrides: Record<string, string> = {}) {
  return {
    workflowId: 'wf-1',
    stepId: 'step-1',
    checklistId: 'chk-1',
    ...overrides,
  };
}

function idemHeaders(extra: Record<string, string> = {}) {
  return authHeaders({
    'Idempotency-Key': 'idem-key-1',
    'If-Match': 'W/"2"',
    ...extra,
  });
}

describe('workflow runtime checklist HTTP handlers (Phase 2.5)', () => {
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

  it('get checklist → 200 with mapped fields', async () => {
    mockEngine.getChecklist.mockResolvedValue(sampleChecklist());
    const res = await getChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.checklistId).toBe('chk-1');
    expect(data.blocksStepCompletion).toBe(true);
    expect(data.linkedAction).toEqual({ actionCode: 'OPEN_LABS' });
    expect(data.effectiveAssignee).toEqual({
      assigneeType: 'user',
      assigneeId: 'usr-1',
      source: 'step',
    });
    expect(data.pk).toBeUndefined();
    expect(mockEngine.getChecklist).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 'step-1',
        checklistId: 'chk-1',
      }),
    );
  });

  it('list workflow checklists → 200', async () => {
    mockEngine.listChecklist.mockResolvedValue([sampleChecklist()]);
    const res = await listWorkflowChecklistsMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.items).toHaveLength(1);
    expect(data.items[0].checklistId).toBe('chk-1');
  });

  it('list checklists by step → 200', async () => {
    mockEngine.listChecklistByStep.mockResolvedValue([sampleChecklist()]);
    const res = await listStepChecklistsMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1', stepId: 'step-1' },
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.items[0].stepId).toBe('step-1');
  });

  const commandCases: Array<{
    name: string;
    main: (e: APIGatewayProxyEvent, c: unknown) => Promise<any>;
    mockKey: string;
    body: Record<string, unknown>;
  }> = [
    { name: 'start', main: startChecklistMain, mockKey: 'startChecklist', body: {} },
    { name: 'complete', main: completeChecklistMain, mockKey: 'completeChecklist', body: {} },
    {
      name: 'skip',
      main: skipChecklistMain,
      mockKey: 'skipChecklist',
      body: { reason: 'n/a' },
    },
    {
      name: 'skip without reason',
      main: skipChecklistMain,
      mockKey: 'skipChecklist',
      body: {},
    },
    {
      name: 'defer',
      main: deferChecklistMain,
      mockKey: 'deferChecklist',
      body: { reason: 'later' },
    },
    {
      name: 'defer without reason',
      main: deferChecklistMain,
      mockKey: 'deferChecklist',
      body: {},
    },
    {
      name: 'block',
      main: blockChecklistMain,
      mockKey: 'blockChecklist',
      body: { reason: 'Patient unreachable after repeated attempts' },
    },
    { name: 'resume', main: resumeChecklistMain, mockKey: 'resumeChecklist', body: {} },
    {
      name: 'cancel',
      main: cancelChecklistMain,
      mockKey: 'cancelChecklist',
      body: { reason: 'stop' },
    },
  ];

  it.each(commandCases)(
    'checklist $name → 200 and forwards OCC + idempotency',
    async ({ main, mockKey, body }) => {
      mockEngine[mockKey].mockResolvedValue({
        checklist: sampleChecklist({ checklistStatus: 'inProgress' }),
        recordVersion: 3,
      });
      const res = await main(
        baseEvent({
          pathParameters: checklistPathParams(),
          headers: idemHeaders(),
          body: JSON.stringify(body),
        }),
        testLambdaContext(),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.checklistId).toBe('chk-1');
      expect(mockEngine[mockKey]).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: 'wf-1',
          stepId: 'step-1',
          checklistId: 'chk-1',
          ifMatch: 'W/"2"',
          idempotencyKey: 'idem-key-1',
          idempotencyScope: 'http',
          actorId: 'user-1',
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        }),
      );
    },
  );

  it('assign checklist is OCC-only (no idempotency key required)', async () => {
    mockEngine.assignChecklist.mockResolvedValue({
      checklist: sampleChecklist({ assigneeId: 'usr-9' }),
      recordVersion: 4,
    });
    const res = await assignChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"3"' }),
        body: JSON.stringify({
          assigneeType: 'user',
          assigneeId: 'usr-9',
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockEngine.assignChecklist).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: 'usr-9',
        ifMatch: 'W/"3"',
      }),
    );
    expect(mockEngine.assignChecklist.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('rejects missing path parameters', async () => {
    const res = await getChecklistMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1' },
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockEngine.getChecklist).not.toHaveBeenCalled();
  });

  it('rejects invalid assign body', async () => {
    const res = await assignChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: JSON.stringify({ assigneeType: 'user' }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockEngine.assignChecklist).not.toHaveBeenCalled();
  });

  it('block requires reason and idempotency key; custom reason is forwarded', async () => {
    const missingReason = await blockChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(missingReason.statusCode).toBe(400);

    const missingIdem = await blockChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({
          reason: 'Patient unreachable after repeated attempts',
        }),
      }),
      testLambdaContext(),
    );
    expect(missingIdem.statusCode).toBe(400);
    expect(mockEngine.blockChecklist).not.toHaveBeenCalled();

    const extraField = await blockChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: JSON.stringify({
          reason: 'Patient unreachable after repeated attempts',
          reasonCode: 'PATIENT_UNREACHABLE',
        }),
      }),
      testLambdaContext(),
    );
    expect(extraField.statusCode).toBe(400);

    mockEngine.blockChecklist.mockResolvedValue({
      checklist: sampleChecklist({
        checklistStatus: 'blocked',
        reason: 'Custom clinic note: patient traveling',
      }),
      recordVersion: 3,
    });
    const ok = await blockChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: JSON.stringify({
          reason: 'Custom clinic note: patient traveling',
          recordVersion: 2,
        }),
      }),
      testLambdaContext(),
    );
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).data.checklistStatus).toBe('blocked');
    expect(JSON.parse(ok.body).data.reason).toBe(
      'Custom clinic note: patient traveling',
    );

    mockEngine.blockChecklist.mockClear();
    const emptyReason = await blockChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: JSON.stringify({ reason: '' }),
      }),
      testLambdaContext(),
    );
    expect(emptyReason.statusCode).toBe(400);
    expect(mockEngine.blockChecklist).not.toHaveBeenCalled();
  });

  it('skip does not require reason and still requires idempotency key', async () => {
    mockEngine.skipChecklist.mockResolvedValue({
      checklist: sampleChecklist({ checklistStatus: 'skipped' }),
      recordVersion: 3,
    });
    const missingReason = await skipChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(missingReason.statusCode).toBe(200);
    expect(mockEngine.skipChecklist).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        checklistId: 'chk-1',
      }),
    );
    expect(mockEngine.skipChecklist.mock.calls[0][0].reason).toBeUndefined();

    mockEngine.skipChecklist.mockClear();
    const missingIdem = await skipChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({ reason: 'n/a' }),
      }),
      testLambdaContext(),
    );
    expect(missingIdem.statusCode).toBe(400);
    expect(mockEngine.skipChecklist).not.toHaveBeenCalled();
  });

  it('defer does not require reason and still requires idempotency key', async () => {
    mockEngine.deferChecklist.mockResolvedValue({
      checklist: sampleChecklist({ checklistStatus: 'deferred' }),
      recordVersion: 3,
    });
    const missingReason = await deferChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(missingReason.statusCode).toBe(200);
    expect(mockEngine.deferChecklist).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        checklistId: 'chk-1',
      }),
    );
    expect(mockEngine.deferChecklist.mock.calls[0][0].reason).toBeUndefined();

    mockEngine.deferChecklist.mockClear();
    const missingIdem = await deferChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({ reason: 'later' }),
      }),
      testLambdaContext(),
    );
    expect(missingIdem.statusCode).toBe(400);
    expect(mockEngine.deferChecklist).not.toHaveBeenCalled();
  });

  it('cancel still requires reason', async () => {
    const missingReason = await cancelChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(missingReason.statusCode).toBe(400);
    expect(mockEngine.cancelChecklist).not.toHaveBeenCalled();
  });

  it('maps checklist not found → 404', async () => {
    mockEngine.getChecklist.mockRejectedValue(new WorkflowEngineNotFoundError());
    const res = await getChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams({ checklistId: 'missing' }),
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('maps invalid lifecycle transition → 409 INVALID_TRANSITION', async () => {
    mockEngine.startChecklist.mockRejectedValue(
      new WorkflowEngineConflictError('bad state', 'INVALID_TRANSITION'),
    );
    const res = await startChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_TRANSITION');
  });

  it('maps VERSION_CONFLICT → 409', async () => {
    mockEngine.completeChecklist.mockRejectedValue(
      new WorkflowEngineConflictError('stale', 'VERSION_CONFLICT'),
    );
    const res = await completeChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('VERSION_CONFLICT');
  });

  it('maps assignment validation failure → 422', async () => {
    mockEngine.assignChecklist.mockRejectedValue(
      new WorkflowEngineValidationError('invalid assignee', [
        { code: 'INVALID_ASSIGNEE', message: 'assignee not allowed' },
      ]),
    );
    const res = await assignChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({
          assigneeType: 'user',
          assigneeId: 'bad',
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(422);
  });

  it('maps required checklist completion validation → 422', async () => {
    mockEngine.completeChecklist.mockRejectedValue(
      new WorkflowEngineValidationError('cannot complete', [
        { code: 'CHECKLIST_NOT_SATISFIED', message: 'required checklist incomplete' },
      ]),
    );
    const res = await completeChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: idemHeaders(),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(422);
  });

  it('legacy checklist without blocksStepCompletion omits field in response', async () => {
    mockEngine.getChecklist.mockResolvedValue(
      sampleChecklist({ blocksStepCompletion: undefined, linkedAction: undefined }),
    );
    const res = await getChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    const data = JSON.parse(res.body).data;
    expect(data.blocksStepCompletion).toBeUndefined();
    expect(data.linkedAction).toBeUndefined();
  });

  it('blocksStepCompletion is returned when present on blocking checklist', async () => {
    mockEngine.listChecklistByStep.mockResolvedValue([
      sampleChecklist({
        required: false,
        blocksStepCompletion: true,
        checklistStatus: 'notStarted',
      }),
    ]);
    const res = await listStepChecklistsMain(
      baseEvent({
        pathParameters: { workflowId: 'wf-1', stepId: 'step-1' },
        headers: authHeaders(),
      }),
      testLambdaContext(),
    );
    const item = JSON.parse(res.body).data.items[0];
    expect(item.blocksStepCompletion).toBe(true);
    expect(item.required).toBe(false);
  });

  it('maps missing If-Match precondition → 428', async () => {
    mockEngine.startChecklist.mockRejectedValue(new WorkflowEnginePreconditionError());
    const res = await startChecklistMain(
      baseEvent({
        pathParameters: checklistPathParams(),
        headers: authHeaders({ 'Idempotency-Key': 'k' }),
        body: '{}',
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(428);
    expect(JSON.parse(res.body).error.code).toBe('PRECONDITION_REQUIRED');
  });
});
