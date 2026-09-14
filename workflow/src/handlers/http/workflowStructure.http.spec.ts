import {
  WorkflowEngineConflictError,
  WorkflowEnginePreconditionError,
} from '@api-hub/workflow-runtime-core';

import {
  bearerToken,
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
          return await handler(req);
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
          return ApiResponse.error(
            e?.statusCode ?? 500,
            {
              title: e?.code ?? 'INTERNAL_ERROR',
              description: e?.message ?? 'Error',
              severity: 'ERROR',
            },
            { correlationId: 'test-correlation-id' },
            { code: e?.code ?? 'INTERNAL_ERROR', details: e?.details },
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
    addStep: jest.fn(),
    removeStep: jest.fn(),
    addChecklist: jest.fn(),
    removeChecklist: jest.fn(),
  };
  return {
    ...actual,
    WorkflowEngineService: jest.fn().mockImplementation(() => mockEngine),
  };
});

import { main as addWorkflowStepMain } from './addWorkflowStep';
import { main as removeWorkflowStepMain } from './removeWorkflowStep';
import { main as addStepChecklistMain } from './addStepChecklist';
import { main as removeStepChecklistMain } from './removeStepChecklist';

const WF = '01M0A4KEACPYC4KAZM1D3EWCZN';

/** Mirrors a real platform token: roles are opaque per-org UUIDs. */
function careManagerHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: bearerToken({
      'custom:organizationID': 'org-1',
      'custom:userID': 'care-manager-1',
      'custom:userType': 'STAFF',
      'custom:role': '["a3f46a0f-2057-45ab-acca-22d25f5a1311"]',
    }),
    'If-Match': 'W/"2"',
    ...extra,
  };
}

function addedStep() {
  return {
    step: {
      organizationId: 'org-1',
      workflowId: WF,
      stepId: 'device-setup',
      name: 'Device Setup',
      stepStatus: 'notStarted',
      sortOrder: 3,
      requirement: 'optional',
      allowSkip: true,
      allowDefer: true,
      createdAt: '2026-08-18T10:00:00.000Z',
      updatedAt: '2026-08-18T10:00:00.000Z',
      updatedBy: 'care-manager-1',
      recordVersion: 1,
    },
    workflowRecordVersion: 3,
  };
}

function addedChecklist() {
  return {
    checklist: {
      organizationId: 'org-1',
      workflowId: WF,
      stepId: 'device-setup',
      checklistId: 'verify-device',
      itemName: 'Verify device installation',
      required: true,
      allowSkip: false,
      allowDefer: false,
      blocksStepCompletion: true,
      checklistStatus: 'notStarted',
      active: true,
      sortOrder: 2,
      createdAt: '2026-08-18T10:00:00.000Z',
      updatedAt: '2026-08-18T10:00:00.000Z',
      recordVersion: 1,
    },
    workflowRecordVersion: 3,
  };
}

describe('patient workflow structure HTTP handlers', () => {
  let envCleanup: () => void;

  beforeAll(() => {
    envCleanup = setupHandlerTestEnv().restore;
  });

  afterAll(() => {
    envCleanup();
  });

  beforeEach(() => {
    resetWorkflowRuntimeHttpControllerForTests();
    Object.values(mockEngine).forEach((fn) => fn.mockReset());
  });

  it('care manager adds a step → 201 with the workflow ETag', async () => {
    mockEngine.addStep.mockResolvedValue(addedStep());

    const res = await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: careManagerHeaders(),
        body: JSON.stringify({
          stepId: 'device-setup',
          name: 'Device Setup',
          requirement: 'optional',
          allowSkip: true,
          allowDefer: true,
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
          sortOrder: 3,
        }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(201);
    expect(res.headers?.ETag).toBe('W/"3"');
    const data = JSON.parse(res.body).data;
    expect(data.recordVersion).toBe(3);
    expect(data.step.stepId).toBe('device-setup');
    expect(mockEngine.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workflowId: WF,
        stepId: 'device-setup',
        ifMatch: 'W/"2"',
        actorId: 'care-manager-1',
      }),
    );
  });

  it('care manager removes a step → 200', async () => {
    mockEngine.removeStep.mockResolvedValue({
      stepId: 'device-setup',
      removedChecklistIds: ['verify-device'],
      workflowRecordVersion: 4,
    });

    const res = await removeWorkflowStepMain(
      baseEvent({
        httpMethod: 'DELETE',
        pathParameters: { workflowId: WF, stepId: 'device-setup' },
        headers: careManagerHeaders(),
        body: null,
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers?.ETag).toBe('W/"4"');
    expect(JSON.parse(res.body).data.removedChecklistIds).toEqual([
      'verify-device',
    ]);
  });

  it('care manager adds a checklist item → 201', async () => {
    mockEngine.addChecklist.mockResolvedValue(addedChecklist());

    const res = await addStepChecklistMain(
      baseEvent({
        pathParameters: { workflowId: WF, stepId: 'device-setup' },
        headers: careManagerHeaders(),
        body: JSON.stringify({
          checklistId: 'verify-device',
          itemName: 'Verify device installation',
          instruction: 'Confirm the device is installed',
          required: true,
          allowSkip: false,
          allowDefer: false,
          sortOrder: 2,
        }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.checklist.checklistId).toBe('verify-device');
  });

  it('care manager removes a checklist item → 200', async () => {
    mockEngine.removeChecklist.mockResolvedValue({
      stepId: 'device-setup',
      checklistId: 'verify-device',
      workflowRecordVersion: 5,
    });

    const res = await removeStepChecklistMain(
      baseEvent({
        httpMethod: 'DELETE',
        pathParameters: {
          workflowId: WF,
          stepId: 'device-setup',
          checklistId: 'verify-device',
        },
        headers: careManagerHeaders(),
        body: null,
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.checklistId).toBe('verify-device');
  });

  it('rejects a token without an organization claim → 401', async () => {
    const res = await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: {
          Authorization: bearerToken({ 'custom:userID': 'care-manager-1' }),
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({ stepId: 'device-setup', name: 'Device Setup' }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(401);
    expect(mockEngine.addStep).not.toHaveBeenCalled();
  });

  it('scopes the write to the caller org, so another tenant cannot be reached', async () => {
    mockEngine.addStep.mockResolvedValue(addedStep());

    await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: {
          Authorization: bearerToken({
            'custom:organizationID': 'other-org',
            'custom:userID': 'care-manager-2',
          }),
          'If-Match': 'W/"1"',
        },
        body: JSON.stringify({ stepId: 'device-setup', name: 'Device Setup' }),
      }),
      testLambdaContext(),
    );

    // The engine looks up ORG#<org>#WORKFLOW#<id>, so a foreign org resolves to 404.
    expect(mockEngine.addStep.mock.calls[0][0].organizationId).toBe('other-org');
  });

  it('rejects an attempt to redefine an existing step through the add route', async () => {
    const res = await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: careManagerHeaders(),
        body: JSON.stringify({
          stepId: 'patient-setup',
          name: 'Renamed Patient Setup',
          instructions: 'new instruction',
        }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(400);
    expect(mockEngine.addStep).not.toHaveBeenCalled();
  });

  it('rejects an attempt to redefine an existing checklist item through the add route', async () => {
    const res = await addStepChecklistMain(
      baseEvent({
        pathParameters: { workflowId: WF, stepId: 'device-setup' },
        headers: careManagerHeaders(),
        body: JSON.stringify({
          checklistId: 'verify-device',
          itemName: 'Renamed',
          active: false,
          checklistStatus: 'completed',
        }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(400);
    expect(mockEngine.addChecklist).not.toHaveBeenCalled();
  });

  it('propagates 428 when no concurrency value is supplied', async () => {
    mockEngine.addStep.mockRejectedValue(new WorkflowEnginePreconditionError());

    const res = await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: careManagerHeaders(),
        body: JSON.stringify({ stepId: 'device-setup', name: 'Device Setup' }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(428);
    expect(JSON.parse(res.body).error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('propagates 409 for a stale version', async () => {
    mockEngine.removeStep.mockRejectedValue(
      new WorkflowEngineConflictError('stale', 'VERSION_CONFLICT'),
    );

    const res = await removeWorkflowStepMain(
      baseEvent({
        httpMethod: 'DELETE',
        pathParameters: { workflowId: WF, stepId: 'device-setup' },
        headers: careManagerHeaders(),
        body: null,
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('VERSION_CONFLICT');
  });

  it('propagates 409 when execution history protects the target', async () => {
    mockEngine.removeChecklist.mockRejectedValue(
      new WorkflowEngineConflictError(
        'has history',
        'EXECUTION_HISTORY_PROTECTED',
      ),
    );

    const res = await removeStepChecklistMain(
      baseEvent({
        httpMethod: 'DELETE',
        pathParameters: {
          workflowId: WF,
          stepId: 'device-setup',
          checklistId: 'verify-device',
        },
        headers: careManagerHeaders(),
        body: null,
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('EXECUTION_HISTORY_PROTECTED');
  });

  it('scopes the command to the org from the token and the workflow from the path', async () => {
    mockEngine.addStep.mockResolvedValue(addedStep());

    await addWorkflowStepMain(
      baseEvent({
        pathParameters: { workflowId: WF },
        headers: careManagerHeaders(),
        body: JSON.stringify({
          stepId: 'device-setup',
          name: 'Device Setup',
          // Callers cannot redirect the write at another tenant or template.
        }),
      }),
      testLambdaContext(),
    );

    const command = mockEngine.addStep.mock.calls[0][0];
    expect(command.organizationId).toBe('org-1');
    expect(command.workflowId).toBe(WF);
    expect(command).not.toHaveProperty('templateId');
    expect(command).not.toHaveProperty('carePlanTemplateId');
  });
});
