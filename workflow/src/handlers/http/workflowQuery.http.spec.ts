import {
  WorkflowQueryFilterError,
} from '@api-hub/workflow-runtime-core';

import {
  baseEvent,
  setupHandlerTestEnv,
  testLambdaContext,
} from '../../__tests__/handler-test-utils';
import { resetWorkflowQueryHttpControllerForTests } from '../../controllers/workflow-query-http.controller';

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
var mockQuery: Record<string, jest.Mock>;

jest.mock('@api-hub/workflow-runtime-core', () => {
  const actual = jest.requireActual<typeof import('@api-hub/workflow-runtime-core')>(
    '@api-hub/workflow-runtime-core',
  );
  mockQuery = {
    getWorkflowById: jest.fn(),
    getWorkflowWithSteps: jest.fn(),
    listHistory: jest.fn(),
    listNotes: jest.fn(),
    listEvidence: jest.fn(),
    listChecklists: jest.fn(),
    listWorkflows: jest.fn(),
    listDashboardQueue: jest.fn(),
  };
  return {
    ...actual,
    WorkflowQueryRepository: jest.fn().mockImplementation(() => mockQuery),
  };
});

import { main as getWorkflowMain } from './getWorkflow';
import { main as listHistoryMain } from './listWorkflowHistory';
import { main as listNotesMain } from './listWorkflowNotes';
import { main as listEvidenceMain } from './listWorkflowEvidence';
import { main as listWorkflowsMain } from './listWorkflows';
import { main as listQueueMain } from './listDashboardQueue';
import { main as workbenchMain } from './getWorkflowWorkbench';
import { main as readinessMain } from './getWorkflowCompletionReadiness';

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
    stepStatus: 'completed',
    sortOrder: 1,
    requirement: 'mandatory',
    allowSkip: false,
    allowDefer: false,
    condition: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    recordVersion: 1,
    ...overrides,
  };
}

describe('workflow query HTTP handlers (WR-08c)', () => {
  let envCleanup: () => void;

  beforeAll(() => {
    envCleanup = setupHandlerTestEnv().restore;
  });

  afterAll(() => {
    envCleanup();
  });

  beforeEach(() => {
    resetWorkflowQueryHttpControllerForTests();
    Object.values(mockQuery).forEach((fn) => {
      fn.mockReset();
    });
  });

  it('get workflow by id → 200', async () => {
    mockQuery.getWorkflowById.mockResolvedValue(sampleWorkflow());
    const res = await getWorkflowMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.workflowId).toBe('wf-1');
    expect(JSON.parse(res.body).data.pk).toBeUndefined();
  });

  it('get workflow with steps → uses getWorkflowWithSteps', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    const res = await getWorkflowMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: { include: 'steps' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.steps).toHaveLength(1);
    expect(mockQuery.getWorkflowWithSteps).toHaveBeenCalled();
  });

  it('get workflow with steps returns snapshotted instructions', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({ instructions: 'Complete patient onboarding' }),
      ],
    });
    const res = await getWorkflowMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: { include: 'steps' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.steps[0].instructions).toBe(
      'Complete patient onboarding',
    );
  });

  it('get workflow → 404', async () => {
    mockQuery.getWorkflowById.mockResolvedValue(null);
    const res = await getWorkflowMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'missing' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('history / notes / evidence paginate', async () => {
    mockQuery.listHistory.mockResolvedValue({
      items: [
        {
          organizationId: 'org-1',
          workflowId: 'wf-1',
          auditId: 'a1',
          action: 'workflow.started',
          timestamp: '2026-07-21T00:00:00.000Z',
        },
      ],
      nextCursor: 'c1',
    });
    mockQuery.listNotes.mockResolvedValue({
      items: [
        {
          organizationId: 'org-1',
          workflowId: 'wf-1',
          noteId: 'n1',
          text: 'hello',
          createdAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({
      items: [
        {
          organizationId: 'org-1',
          workflowId: 'wf-1',
          evidenceId: 'e1',
          stepId: 'step-1',
          refType: 'document',
          refId: 'doc-1',
          addedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    });

    const history = await listHistoryMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: { limit: '10', cursor: 'prev' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(history.statusCode).toBe(200);
    expect(JSON.parse(history.body).data.nextCursor).toBe('c1');

    const notes = await listNotesMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(notes.statusCode).toBe(200);
    expect(JSON.parse(notes.body).data.nextCursor).toBeNull();

    const evidence = await listEvidenceMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: { stepId: 'step-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(evidence.statusCode).toBe(200);
    expect(mockQuery.listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 'step-1' }),
    );
  });

  it.each([
    { patientId: 'pat-1' },
    { carePlanId: 'cp-1' },
    { assigneeType: 'user', assigneeId: 'usr-1' },
    { workflowStatus: 'inProgress' },
    { workflowType: 'FORMAL_REVIEW' },
  ])('list workflows filter %# → 200', async (query) => {
    mockQuery.listWorkflows.mockResolvedValue({
      items: [sampleWorkflow()],
      nextCursor: undefined,
    });
    const res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: query,
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockQuery.listWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', ...query }),
    );
  });

  it('list workflows maps unsupported / ambiguous / invalid cursor', async () => {
    mockQuery.listWorkflows.mockRejectedValueOnce(
      new WorkflowQueryFilterError('unsupported', 'UNSUPPORTED_FILTER'),
    );
    let res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { patientId: 'pat-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UNSUPPORTED_FILTER');

    mockQuery.listWorkflows.mockRejectedValueOnce(
      new WorkflowQueryFilterError('ambiguous', 'AMBIGUOUS_FILTER'),
    );
    res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { patientId: 'pat-1', carePlanId: 'cp-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('AMBIGUOUS_FILTER');

    mockQuery.listWorkflows.mockRejectedValueOnce(
      new WorkflowQueryFilterError('bad cursor', 'INVALID_CURSOR'),
    );
    res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { patientId: 'pat-1', cursor: 'nope' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(JSON.parse(res.body).error.code).toBe('INVALID_CURSOR');
  });

  it('list workflows with carePlanId enriches assignee from runtime steps for legacy instances', async () => {
    mockQuery.listWorkflows.mockResolvedValue({
      items: [sampleWorkflow({ workflowType: 'PATIENT_ONBOARDING' })],
      nextCursor: undefined,
    });
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow({ workflowType: 'PATIENT_ONBOARDING' }),
      steps: [
        sampleStep({
          name: 'Complete Patient Profile',
          stepStatus: 'notStarted',
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
        }),
      ],
    });
    const res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { carePlanId: 'cp-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const item = JSON.parse(res.body).data.items[0];
    expect(item.assigneeType).toBe('role');
    expect(item.assigneeId).toBe('careCoordinator');
    expect(mockQuery.getWorkflowWithSteps).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', workflowId: 'wf-1' }),
    );
  });

  it('list workflows without carePlanId does not enrich assignee from steps', async () => {
    mockQuery.listWorkflows.mockResolvedValue({
      items: [sampleWorkflow()],
      nextCursor: undefined,
    });
    const res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { patientId: 'pat-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.items[0]).not.toHaveProperty('assigneeType');
    expect(mockQuery.getWorkflowWithSteps).not.toHaveBeenCalled();
  });

  it('list workflows with carePlanId still returns 200 when assignee cannot be resolved', async () => {
    mockQuery.listWorkflows.mockResolvedValue({
      items: [sampleWorkflow()],
      nextCursor: undefined,
    });
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    const res = await listWorkflowsMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { carePlanId: 'cp-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.items[0]).not.toHaveProperty('assigneeType');
  });

  it.each([
    'my',
    'blocked',
    'waiting',
    'overdue',
    'onboardingPending',
    'formalReviewDue',
    'closureReviewDue',
  ])('dashboard queue %s → 200', async (queue) => {
    mockQuery.listDashboardQueue.mockResolvedValue({
      items: [sampleWorkflow()],
    });
    const res = await listQueueMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { queue },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(mockQuery.listDashboardQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        queue,
        ...(queue === 'my' ? { assigneeUserId: 'user-1' } : {}),
      }),
    );
  });

  it('dashboard queue unknown → 400', async () => {
    const res = await listQueueMain(
      baseEvent({
        httpMethod: 'GET',
        queryStringParameters: { queue: 'nope' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UNSUPPORTED_FILTER');
  });

  it('workbench → 200 projection', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.stepsTracker).toHaveLength(1);
    expect(data.stepsTracker[0]).not.toHaveProperty('linkedAction');
    expect(data.stepsTracker[0].checklists).toEqual([]);
    expect(data.progress).toEqual({ completed: 1, totalApplicable: 1 });
    expect(data.workflow.pk).toBeUndefined();
    expect(mockQuery.listChecklists).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', workflowId: 'wf-1' }),
    );
  });

  it('workbench returns step assigneeType and assigneeId for PDP Assignee column', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow({
        assigneeType: 'role',
        assigneeId: 'careCoordinator',
      }),
      steps: [
        sampleStep({
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.workflow.assigneeType).toBe('role');
    expect(data.workflow.assigneeId).toBe('careCoordinator');
    expect(data.stepsTracker[0].assigneeType).toBe('role');
    expect(data.stepsTracker[0].assigneeId).toBe('careCoordinator');
  });

  it('workbench returns checklist effective assignee distinct from parent step', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow({
        assigneeType: 'role',
        assigneeId: 'CARE_MANAGER',
      }),
      steps: [
        sampleStep({
          assigneeType: 'role',
          assigneeId: 'CARE_MANAGER',
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 'step-1',
        checklistId: 'chk-override',
        itemName: 'Verify patient demographics',
        required: true,
        allowSkip: false,
        allowDefer: false,
        assigneeOverride: { assigneeType: 'role', assigneeId: 'CARE_COORDINATOR' },
        checklistStatus: 'completed',
        active: true,
        sortOrder: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
    ]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.stepsTracker[0].assigneeId).toBe('CARE_MANAGER');
    expect(data.stepsTracker[0].checklists[0].assigneeType).toBe('role');
    expect(data.stepsTracker[0].checklists[0].assigneeId).toBe('CARE_COORDINATOR');
  });

  it('workbench omits assignee fields when the step has none', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.workflow).not.toHaveProperty('assigneeType');
    expect(data.stepsTracker[0]).not.toHaveProperty('assigneeType');
    expect(data.stepsTracker[0]).not.toHaveProperty('assigneeId');
  });

  it('workbench returns snapshotted step instructions', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({ instructions: 'Complete patient onboarding' }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.stepsTracker[0].instructions).toBe(
      'Complete patient onboarding',
    );
  });

  it('workbench returns snapshotted step linkedAction', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({
          name: 'Patient Setup',
          stepStatus: 'notStarted',
          linkedAction: { actionCode: 'OPEN_BASELINE' },
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.stepsTracker[0].linkedAction).toEqual({
      actionCode: 'OPEN_BASELINE',
    });
  });

  it('workbench preserves distinct linkedAction codes per step', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({
          stepId: 's1',
          name: 'Patient Setup',
          stepStatus: 'notStarted',
          sortOrder: 1,
          linkedAction: { actionCode: 'OPEN_BASELINE' },
        }),
        sampleStep({
          stepId: 's2',
          name: 'Device Setup',
          stepStatus: 'notStarted',
          sortOrder: 2,
          linkedAction: { actionCode: 'OPEN_DEVICE_SETUP' },
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const tracker = JSON.parse(res.body).data.stepsTracker;
    expect(tracker).toHaveLength(2);
    expect(tracker[0].linkedAction).toEqual({ actionCode: 'OPEN_BASELINE' });
    expect(tracker[1].linkedAction).toEqual({
      actionCode: 'OPEN_DEVICE_SETUP',
    });
  });

  it('workbench does not replace step linkedAction with checklist linkedAction', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({
          linkedAction: { actionCode: 'OPEN_BASELINE' },
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 'step-1',
        checklistId: 'cl-1',
        itemName: 'Verify labs',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: 'notStarted',
        active: true,
        sortOrder: 1,
        linkedAction: { actionCode: 'OPEN_LABS' },
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
    ]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.stepsTracker[0].linkedAction).toEqual({
      actionCode: 'OPEN_BASELINE',
    });
    expect(data).not.toHaveProperty('checklists');
    expect(data.stepsTracker[0].checklists).toEqual([
      expect.objectContaining({
        checklistId: 'cl-1',
        itemName: 'Verify labs',
        checklistStatus: 'notStarted',
        sortOrder: 1,
        linkedAction: { actionCode: 'OPEN_LABS' },
      }),
    ]);
  });

  it('workbench nests checklists under the correct step and preserves sortOrder', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({
          stepId: 's1',
          name: 'Patient Setup',
          stepStatus: 'notStarted',
          sortOrder: 1,
        }),
        sampleStep({
          stepId: 's2',
          name: 'Device Setup',
          stepStatus: 'notStarted',
          sortOrder: 2,
        }),
        sampleStep({
          stepId: 's3',
          name: 'Manual Confirm',
          stepStatus: 'notStarted',
          sortOrder: 3,
        }),
      ],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockResolvedValue([
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 's2',
        checklistId: 'chk-b',
        itemName: 'Pair device',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: 'inProgress',
        active: true,
        sortOrder: 2,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 's1',
        checklistId: 'chk-goals',
        itemName: 'Confirm patient care goals',
        instruction: 'Review care goals with the patient',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: 'notStarted',
        active: true,
        sortOrder: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 's2',
        checklistId: 'chk-a',
        itemName: 'Unbox device',
        required: true,
        allowSkip: false,
        allowDefer: false,
        blocksStepCompletion: true,
        checklistStatus: 'completed',
        active: true,
        sortOrder: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
    ]);
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.stepsTracker.map((s: { stepId: string }) => s.stepId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(data.stepsTracker[0].checklists).toEqual([
      expect.objectContaining({
        checklistId: 'chk-goals',
        itemName: 'Confirm patient care goals',
        instruction: 'Review care goals with the patient',
        checklistStatus: 'notStarted',
        recordVersion: 1,
        sortOrder: 1,
      }),
    ]);
    expect(data.stepsTracker[1].checklists).toEqual([
      expect.objectContaining({
        checklistId: 'chk-a',
        checklistStatus: 'completed',
        recordVersion: 1,
        sortOrder: 1,
      }),
      expect.objectContaining({
        checklistId: 'chk-b',
        checklistStatus: 'inProgress',
        recordVersion: 1,
        sortOrder: 2,
      }),
    ]);
    expect(data.stepsTracker[2].checklists).toEqual([]);
    expect(mockQuery.listChecklists).toHaveBeenCalledTimes(1);
    expect(mockQuery.listChecklists).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', workflowId: 'wf-1' }),
    );
  });

  it('workbench → 500 when checklist retrieval fails', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    mockQuery.listEvidence.mockResolvedValue({ items: [] });
    mockQuery.listChecklists.mockRejectedValue(new Error('ddb unavailable'));
    const res = await workbenchMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(500);
  });

  it('completion readiness → 200 when steps and checklists satisfied', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [sampleStep()],
    });
    mockQuery.listChecklists.mockResolvedValue([
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 'step-1',
        checklistId: 'cl-1',
        itemName: 'Confirm',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: 'completed',
        active: true,
        sortOrder: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
    ]);
    const res = await readinessMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.ready).toBe(true);
    expect(mockQuery.listChecklists).toHaveBeenCalled();
  });

  it('completion readiness → not ready when required checklist incomplete on open step', async () => {
    mockQuery.getWorkflowWithSteps.mockResolvedValue({
      workflow: sampleWorkflow(),
      steps: [
        sampleStep({
          stepStatus: 'inProgress',
          allowSkip: false,
          allowDefer: false,
        }),
      ],
    });
    mockQuery.listChecklists.mockResolvedValue([
      {
        organizationId: 'org-1',
        workflowId: 'wf-1',
        stepId: 'step-1',
        checklistId: 'cl-1',
        itemName: 'Confirm',
        required: true,
        allowSkip: false,
        allowDefer: false,
        checklistStatus: 'notStarted',
        active: true,
        sortOrder: 1,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
      },
    ]);
    const res = await readinessMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: {},
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.ready).toBe(false);
    expect(data.missingRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: 'step-1',
          checklistId: 'cl-1',
        }),
      ]),
    );
  });

  it('nested list rejects extra query params', async () => {
    const res = await listNotesMain(
      baseEvent({
        httpMethod: 'GET',
        pathParameters: { workflowId: 'wf-1' },
        queryStringParameters: { foo: 'bar' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UNSUPPORTED_FILTER');
  });
});
