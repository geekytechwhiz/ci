import type { MiddlewarePipelineEvent } from '@api-hub/middleware';
import { WorkflowTemplateConflictError } from '@api-hub/workflow-runtime-core';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import {
  authHeaders,
  baseEvent,
  sampleCreateTemplateBody,
  sampleTemplateChecklist,
  sampleTemplateStep,
  setupHandlerTestEnv,
  testLambdaContext,
} from '../../__tests__/handler-test-utils';
import { resetCarePlanWorkflowMappingHttpControllerForTests } from '../../controllers/care-plan-workflow-mapping-http.controller';
import { resetWorkflowTemplateHttpControllerForTests } from '../../controllers/workflow-template-http.controller';
import { WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION } from '../../utils/workflow-template-validation-http-error';

// eslint-disable-next-line no-var
var mockGetProfilesByIds: jest.Mock;

jest.mock('../../infrastructure/user/user-profile.repository', () => {
  mockGetProfilesByIds = jest.fn().mockResolvedValue(new Map());
  return {
    getUserProfileRepository: () => ({
      getProfilesByIds: (...args: unknown[]) => mockGetProfilesByIds(...args),
      getByUserId: jest.fn(),
    }),
    resetUserProfileRepositoryForTests: jest.fn(),
  };
});

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
            {
              title: 'INVALID_JSON',
              description: 'Invalid JSON body',
              severity: 'ERROR',
            },
            { correlationId: 'test-correlation-id' },
            { code: 'INVALID_JSON' },
          );
        }

        const authHeader =
          event?.headers?.Authorization ?? event?.headers?.authorization;
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
          if (
            out &&
            typeof out === 'object' &&
            'statusCode' in out &&
            'body' in out
          ) {
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
              {
                code: 'VALIDATION_ERROR',
                details: e.issues.map((i: any) => ({
                  field: i.path.join('.'),
                  message: i.message,
                })),
              },
            );
          }
          const statusCode = e?.statusCode ?? 500;
          const code = e?.code ?? 'INTERNAL_ERROR';
          return ApiResponse.error(
            statusCode,
            {
              title: code,
              description: e?.message ?? 'Error',
              severity: 'ERROR',
            },
            { correlationId: 'test-correlation-id' },
            { code, details: e?.details },
          );
        }
      },
  };
});

// eslint-disable-next-line no-var
var mockCreatePlatform: jest.Mock;
// eslint-disable-next-line no-var
var mockCreateOrg: jest.Mock;
// eslint-disable-next-line no-var
var mockUpdateDraft: jest.Mock;
// eslint-disable-next-line no-var
var mockPublish: jest.Mock;
// eslint-disable-next-line no-var
var mockInactivate: jest.Mock;
// eslint-disable-next-line no-var
var mockGetTemplate: jest.Mock;
// eslint-disable-next-line no-var
var mockListTemplates: jest.Mock;
// eslint-disable-next-line no-var
var mockListHistory: jest.Mock;
// eslint-disable-next-line no-var
var mockPutMappings: jest.Mock;
// eslint-disable-next-line no-var
var mockGetAggregate: jest.Mock;
// eslint-disable-next-line no-var
var mockDeleteMapping: jest.Mock;
// eslint-disable-next-line no-var
var mockEnsureOrgCopies: jest.Mock;

jest.mock('@api-hub/workflow-runtime-core', () => {
  const actual = jest.requireActual<
    typeof import('@api-hub/workflow-runtime-core')
  >('@api-hub/workflow-runtime-core');
  mockCreatePlatform = jest.fn();
  mockCreateOrg = jest.fn();
  mockUpdateDraft = jest.fn();
  mockPublish = jest.fn();
  mockInactivate = jest.fn();
  mockGetTemplate = jest.fn();
  mockListTemplates = jest.fn();
  mockListHistory = jest.fn();
  mockPutMappings = jest.fn();
  mockGetAggregate = jest.fn();
  mockDeleteMapping = jest.fn();
  mockEnsureOrgCopies = jest.fn();
  return {
    ...actual,
    WorkflowTemplateWriteRepository: jest.fn().mockImplementation(() => ({
      createPlatformTemplate: mockCreatePlatform,
      createOrgTemplate: mockCreateOrg,
      updateDraft: mockUpdateDraft,
      publish: mockPublish,
      inactivate: mockInactivate,
    })),
    WorkflowTemplateQueryRepository: jest.fn().mockImplementation(() => ({
      getTemplate: mockGetTemplate,
      listTemplates: mockListTemplates,
      listHistory: mockListHistory,
    })),
    OrgWorkflowTemplateForkService: jest.fn().mockImplementation(() => ({
      ensureOrgCopies: mockEnsureOrgCopies,
    })),
    CarePlanWorkflowMappingWriteRepository: jest.fn().mockImplementation(() => ({
      putMappings: mockPutMappings,
      deleteMapping: mockDeleteMapping,
    })),
    CarePlanWorkflowMappingQueryRepository: jest.fn().mockImplementation(() => ({
      getAggregate: mockGetAggregate,
    })),
  };
});

import { main as createPlatformMain } from './createPlatformWorkflowTemplate';
import { main as updatePlatformMain } from './updatePlatformWorkflowTemplate';
import { main as publishPlatformMain } from './publishPlatformWorkflowTemplate';
import { main as inactivatePlatformMain } from './inactivatePlatformWorkflowTemplate';
import { main as clonePlatformMain } from './clonePlatformWorkflowTemplate';
import { main as getPlatformMain } from './getPlatformWorkflowTemplate';
import { main as listPlatformHistoryMain } from './listPlatformWorkflowTemplateHistory';
import { main as listPlatformMain } from './listPlatformWorkflowTemplates';
import { main as createOrgMain } from './createOrgWorkflowTemplate';
import { main as listOrgMain } from './listOrgWorkflowTemplates';
import { main as getOrgMain } from './getOrgWorkflowTemplate';
import { main as updateOrgMain } from './updateOrgWorkflowTemplate';
import { main as publishOrgMain } from './publishOrgWorkflowTemplate';
import { main as inactivateOrgMain } from './inactivateOrgWorkflowTemplate';
import { main as getMappingsMain } from './getCarePlanWorkflowMappings';
import { main as putMappingsMain } from './putCarePlanWorkflowMappings';
import { main as deleteMappingMain } from './deleteCarePlanWorkflowMapping';
import { main as ensureFromPlatformMain } from './ensureOrgWorkflowTemplatesFromPlatform';

function sampleTemplateAggregate(overrides: Record<string, unknown> = {}) {
  const now = '2026-07-21T00:00:00.000Z';
  const metadata = {
    scope: 'platform',
    templateId: 'tmpl-1',
    templateName: 'Standard Onboarding Template',
    workflowType: 'PATIENT_ONBOARDING',
    workflowStage: 'PATIENT_ONBOARDING',
    status: 'draft',
    version: 1,
    description: 'desc',
    program: 'rpm',
    condition: 'htn',
    basedOn: 'platform-base',
    defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
    stepCount: 1,
    checklistItemCount: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    recordVersion: 1,
    entityType: 'PlatformWorkflowTemplate',
    pk: 'ignored',
    sk: 'ignored',
    gsi6pk: 'ignored',
    gsi6sk: 'ignored',
    ...overrides,
  };
  const steps = [
    {
      scope: 'platform',
      templateId: 'tmpl-1',
      stepId: 'verifyDemographics',
      name: 'Verify demographics',
      instructions: 'Check ID',
      requirement: 'mandatory',
      allowSkip: false,
      allowDefer: false,
      condition: null,
      sortOrder: 1,
      defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
      createdAt: now,
      updatedAt: now,
      entityType: 'WorkflowTemplateStep',
      pk: 'ignored',
      sk: 'ignored',
    },
  ];
  const checklists = [
    {
      scope: 'platform',
      templateId: 'tmpl-1',
      stepId: 'verifyDemographics',
      checklistId: 'confirmName',
      itemName: 'Confirm name',
      instruction: 'Match ID',
      required: true,
      allowSkip: false,
      allowDefer: false,
      active: true,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
      entityType: 'WorkflowTemplateChecklist',
      pk: 'ignored',
      sk: 'ignored',
    },
  ];
  return { metadata, steps, checklists };
}

function platformEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
): MiddlewarePipelineEvent {
  return baseEvent({
    path: '/dev/v1/platform/workflow-templates',
    ...overrides,
  });
}

function orgEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
): MiddlewarePipelineEvent {
  return baseEvent({
    path: '/dev/v1/organizations/org-1/workflow-templates',
    pathParameters: { orgId: 'org-1' },
    ...overrides,
  });
}

describe('workflow template HTTP handlers', () => {
  let envCleanup: () => void;

  beforeAll(() => {
    envCleanup = setupHandlerTestEnv().restore;
  });

  afterAll(() => {
    envCleanup();
  });

  beforeEach(() => {
    resetWorkflowTemplateHttpControllerForTests();
    resetCarePlanWorkflowMappingHttpControllerForTests();
    mockCreatePlatform.mockReset();
    mockCreateOrg.mockReset();
    mockUpdateDraft.mockReset();
    mockPublish.mockReset();
    mockInactivate.mockReset();
    mockGetTemplate.mockReset();
    mockListTemplates.mockReset();
    mockListHistory.mockReset();
    mockPutMappings.mockReset();
    mockGetAggregate.mockReset();
    mockDeleteMapping.mockReset();
    mockEnsureOrgCopies.mockReset();
    mockGetProfilesByIds.mockReset();
    mockGetProfilesByIds.mockResolvedValue(new Map());
  });

  it('create platform template → 201 with ETag and no pk', async () => {
    mockCreatePlatform.mockResolvedValue(sampleTemplateAggregate());
    const res = await createPlatformMain(
      platformEvent({ body: JSON.stringify(sampleCreateTemplateBody()) }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('draft');
    expect(body.data.templateId).toBe('tmpl-1');
    expect(body.data.steps[0].checklists).toHaveLength(1);
    expect(body.data.pk).toBeUndefined();
    expect(body.data.gsi6pk).toBeUndefined();
    expect(res.headers?.ETag).toBe('W/"1"');
    expect(body.data.workflowType).toBe('PATIENT_ONBOARDING');
    expect(body.data.workflowStage).toBe('PATIENT_ONBOARDING');
    expect(mockCreatePlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'PATIENT_ONBOARDING',
        workflowStage: 'PATIENT_ONBOARDING',
      }),
    );
  });

  it.each([
    ['FORMAL_REVIEW', 'FORMAL_REVIEW'],
    ['CLOSURE_REVIEW', 'CLOSURE_REVIEW'],
  ] as const)(
    'create platform template accepts %s workflowType/stage',
    async (code) => {
      mockCreatePlatform.mockResolvedValue(
        sampleTemplateAggregate({
          workflowType: code,
          workflowStage: code,
        }),
      );
      const res = await createPlatformMain(
        platformEvent({
          body: JSON.stringify(
            sampleCreateTemplateBody({
              workflowType: code,
              workflowStage: code,
            }),
          ),
        }),
        testLambdaContext(),
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body).data;
      expect(data.workflowType).toBe(code);
      expect(data.workflowStage).toBe(code);
      expect(mockCreatePlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowType: code,
          workflowStage: code,
        }),
      );
    },
  );

  it('create rejects camelCase workflowType patientOnboarding', async () => {
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(
          sampleCreateTemplateBody({ workflowType: 'patientOnboarding' }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockCreatePlatform).not.toHaveBeenCalled();
  });

  it('create rejects camelCase workflowStage patientOnboarding', async () => {
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(
          sampleCreateTemplateBody({ workflowStage: 'patientOnboarding' }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockCreatePlatform).not.toHaveBeenCalled();
  });

  it('create keeps Metadata Registry assignee and linkedAction codes', async () => {
    mockCreatePlatform.mockResolvedValue(
      sampleTemplateAggregate({
        defaultAssignee: {
          assigneeType: 'role',
          assigneeId: 'CARE_COORDINATOR',
        },
      }),
    );
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(
          sampleCreateTemplateBody({
            defaultAssignee: {
              assigneeType: 'role',
              assigneeId: 'CARE_COORDINATOR',
            },
            steps: [
              sampleTemplateStep({
                linkedAction: { actionCode: 'OPEN_BASELINE' },
                defaultAssignee: {
                  assigneeType: 'role',
                  assigneeId: 'CARE_COORDINATOR',
                },
              }),
            ],
          }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    expect(mockCreatePlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultAssignee: {
          assigneeType: 'role',
          assigneeId: 'CARE_COORDINATOR',
        },
        steps: [
          expect.objectContaining({
            linkedAction: { actionCode: 'OPEN_BASELINE' },
            defaultAssignee: {
              assigneeType: 'role',
              assigneeId: 'CARE_COORDINATOR',
            },
          }),
        ],
      }),
    );
  });

  it('create org template → 201', async () => {
    mockCreateOrg.mockResolvedValue(
      sampleTemplateAggregate({
        scope: 'organization',
        organizationId: 'org-1',
      }),
    );
    const res = await createOrgMain(
      orgEvent({ body: JSON.stringify(sampleCreateTemplateBody()) }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    expect(mockCreateOrg).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('create rejects >80 steps with 422 MAX_STEPS_EXCEEDED', async () => {
    const steps = Array.from({ length: 81 }, (_, i) =>
      sampleTemplateStep({
        stepId: `step${i}`,
        sortOrder: i + 1,
        checklists: [],
      }),
    );
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(sampleCreateTemplateBody({ steps })),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('MAX_STEPS_EXCEEDED');
  });

  it.each([19, 20, 45])(
    'create accepts %i checklist items on one step',
    async (count) => {
      mockCreatePlatform.mockResolvedValue(sampleTemplateAggregate());
      const steps = [
        sampleTemplateStep({
          checklists: Array.from({ length: count }, (_, i) =>
            sampleTemplateChecklist({
              checklistId: `item${i}`,
              sortOrder: i + 1,
            }),
          ),
        }),
      ];

      const res = await createPlatformMain(
        platformEvent({
          body: JSON.stringify(sampleCreateTemplateBody({ steps })),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(201);
      expect(mockCreatePlatform.mock.calls[0][0].steps[0].checklists).toHaveLength(
        count,
      );
    },
  );

  it('create accepts 30+ checklist items spread over several steps', async () => {
    mockCreatePlatform.mockResolvedValue(sampleTemplateAggregate());
    const steps = Array.from({ length: 4 }, (_, s) =>
      sampleTemplateStep({
        stepId: `step${s}`,
        sortOrder: s + 1,
        checklists: Array.from({ length: 10 }, (_, i) =>
          sampleTemplateChecklist({
            checklistId: `s${s}-item${i}`,
            sortOrder: i + 1,
          }),
        ),
      }),
    );

    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(sampleCreateTemplateBody({ steps })),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(201);
  });

  it('create rejects duplicate checklistId', async () => {
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(
          sampleCreateTemplateBody({
            steps: [
              sampleTemplateStep({
                checklists: [
                  sampleTemplateChecklist({ checklistId: 'dup' }),
                  sampleTemplateChecklist({
                    checklistId: 'dup',
                    sortOrder: 2,
                  }),
                ],
              }),
            ],
          }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
  });

  describe('blank checklist item validation messages', () => {
    function blankChecklistBody() {
      return sampleCreateTemplateBody({
        steps: [
          sampleTemplateStep({
            checklists: [
              sampleTemplateChecklist({
                checklistId: '',
                itemName: '',
              }),
            ],
          }),
        ],
      });
    }

    function assertFriendlyChecklistError(res: { statusCode: number; body: string }) {
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.message.description).toBe(
        WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION,
      );
      expect(body.message.description).not.toContain('steps.');
      expect(body.message.description).not.toContain('checklists.');
      expect(body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'steps.0.checklists.0.checklistId',
            message: 'Please provide a checklist item ID.',
          }),
          expect.objectContaining({
            field: 'steps.0.checklists.0.itemName',
            message: 'Please enter a checklist item.',
          }),
        ]),
      );
      for (const detail of body.error.details ?? []) {
        expect(detail.message ?? '').not.toMatch(/Too small/i);
      }
      expect(body.message.description ?? '').not.toMatch(/Too small/i);
    }

    it('create rejects a blank checklist item with user-friendly VALIDATION_ERROR', async () => {
      const res = await createPlatformMain(
        platformEvent({ body: JSON.stringify(blankChecklistBody()) }),
        testLambdaContext(),
      );
      assertFriendlyChecklistError(res);
      expect(mockCreatePlatform).not.toHaveBeenCalled();
    });

    it('update rejects a blank checklist item with user-friendly VALIDATION_ERROR', async () => {
      const res = await updatePlatformMain(
        platformEvent({
          httpMethod: 'PUT',
          path: '/dev/v1/platform/workflow-templates/tmpl-1',
          pathParameters: { templateId: 'tmpl-1' },
          headers: authHeaders({ 'If-Match': 'W/"1"' }),
          body: JSON.stringify({
            templateName: 'Updated',
            steps: blankChecklistBody().steps,
          }),
        }),
        testLambdaContext(),
      );
      assertFriendlyChecklistError(res);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    });

    it('create uses a generic description for itemName and duplicate stepId errors', async () => {
      const res = await createPlatformMain(
        platformEvent({
          body: JSON.stringify(
            sampleCreateTemplateBody({
              steps: [
                sampleTemplateStep({
                  stepId: 'step-test',
                  sortOrder: 1,
                }),
                sampleTemplateStep({
                  stepId: 'step-test',
                  sortOrder: 2,
                  checklists: [
                    sampleTemplateChecklist({
                      itemName: '',
                    }),
                  ],
                }),
              ],
            }),
          ),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.message.description).toBe(
        WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION,
      );
      expect(body.message.description).not.toContain(
        'steps.1.checklists.0.itemName',
      );
      expect(body.message.description).not.toContain('steps.1.stepId');
      expect(body.message.description).not.toMatch(/Too small/i);
      expect(body.error.details).toEqual(
        expect.arrayContaining([
          {
            field: 'steps.1.checklists.0.itemName',
            message: 'Please enter a checklist item.',
          },
          {
            field: 'steps.1.stepId',
            message: 'Duplicate stepId: step-test',
          },
        ]),
      );
      expect(mockCreatePlatform).not.toHaveBeenCalled();
    });
  });

  describe('catalog metadata (Category / SelectScope / Language / Country)', () => {
    const ALL_METADATA = {
      category: 'CHRONIC',
      shareScope: 'ORGANIZATION',
      language: 'ENGLISH',
      country: 'IN',
    };

    async function createWithMetadata(metadata: Record<string, string>) {
      mockCreatePlatform.mockResolvedValue(
        sampleTemplateAggregate({ ...metadata }),
      );
      const res = await createPlatformMain(
        platformEvent({
          body: JSON.stringify(sampleCreateTemplateBody({ ...metadata })),
        }),
        testLambdaContext(),
      );
      return res;
    }

    it.each([
      ['category', { category: 'CHRONIC' }],
      ['shareScope', { shareScope: 'ORGANIZATION' }],
      ['language', { language: 'ENGLISH' }],
      ['country', { country: 'IN' }],
    ])('create with %s persists the value code', async (field, metadata) => {
      const res = await createWithMetadata(metadata);

      expect(res.statusCode).toBe(201);
      expect(mockCreatePlatform).toHaveBeenCalledWith(
        expect.objectContaining(metadata),
      );
      expect(JSON.parse(res.body).data[field]).toBe(
        Object.values(metadata)[0],
      );
    });

    it('create with all four persists and returns every field', async () => {
      const res = await createWithMetadata(ALL_METADATA);

      expect(res.statusCode).toBe(201);
      expect(mockCreatePlatform).toHaveBeenCalledWith(
        expect.objectContaining(ALL_METADATA),
      );
      expect(JSON.parse(res.body).data).toMatchObject(ALL_METADATA);
    });

    it.each([
      ['lowercase', { category: 'chronic' }],
      ['spaced', { language: 'EN GLISH' }],
      ['leading underscore', { country: '_IN' }],
      ['empty', { shareScope: '' }],
    ])(
      'create rejects an invalid metadata reference (%s) → 400',
      async (_label, metadata) => {
        const res = await createPlatformMain(
          platformEvent({
            body: JSON.stringify(sampleCreateTemplateBody({ ...metadata })),
          }),
          testLambdaContext(),
        );

        expect(res.statusCode).toBe(400);
        expect(mockCreatePlatform).not.toHaveBeenCalled();
      },
    );

    it('create without metadata stays valid and writes nothing extra', async () => {
      mockCreatePlatform.mockResolvedValue(sampleTemplateAggregate());
      const res = await createPlatformMain(
        platformEvent({ body: JSON.stringify(sampleCreateTemplateBody()) }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(201);
      const input = mockCreatePlatform.mock.calls[0][0];
      expect(input.category).toBeUndefined();
      expect(input.shareScope).toBeUndefined();
      expect(input.language).toBeUndefined();
      expect(input.country).toBeUndefined();
    });

    it('update forwards metadata to the draft write', async () => {
      mockUpdateDraft.mockResolvedValue(
        sampleTemplateAggregate({ recordVersion: 2, ...ALL_METADATA }),
      );
      const res = await updatePlatformMain(
        platformEvent({
          httpMethod: 'PUT',
          pathParameters: { templateId: 'tmpl-1' },
          headers: authHeaders({ 'If-Match': 'W/"1"' }),
          body: JSON.stringify({
            templateName: 'Updated',
            ...ALL_METADATA,
            steps: [sampleTemplateStep()],
          }),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      expect(mockUpdateDraft).toHaveBeenCalledWith(
        expect.objectContaining(ALL_METADATA),
      );
      expect(JSON.parse(res.body).data).toMatchObject(ALL_METADATA);
    });

    it('update rejects an invalid metadata reference → 400', async () => {
      const res = await updatePlatformMain(
        platformEvent({
          httpMethod: 'PUT',
          pathParameters: { templateId: 'tmpl-1' },
          headers: authHeaders({ 'If-Match': 'W/"1"' }),
          body: JSON.stringify({
            templateName: 'Updated',
            category: 'not a code',
            steps: [sampleTemplateStep()],
          }),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(400);
      expect(mockUpdateDraft).not.toHaveBeenCalled();
    });

    it('GET returns metadata for a draft template', async () => {
      mockGetTemplate.mockResolvedValue(
        sampleTemplateAggregate({ status: 'draft', ...ALL_METADATA }),
      );
      const res = await getPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          pathParameters: { templateId: 'tmpl-1' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;
      expect(data.status).toBe('draft');
      expect(data).toMatchObject(ALL_METADATA);
    });

    it('GET returns metadata for a published template', async () => {
      mockGetTemplate.mockResolvedValue(
        sampleTemplateAggregate({ status: 'published', ...ALL_METADATA }),
      );
      const res = await getPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          pathParameters: { templateId: 'tmpl-1' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;
      expect(data.status).toBe('published');
      expect(data).toMatchObject(ALL_METADATA);
    });

    it('GET omits metadata on a template created before the fields existed', async () => {
      mockGetTemplate.mockResolvedValue(sampleTemplateAggregate());
      const res = await getPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          pathParameters: { templateId: 'tmpl-1' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;
      expect(data.templateId).toBe('tmpl-1');
      expect(data).not.toHaveProperty('category');
      expect(data).not.toHaveProperty('shareScope');
      expect(data).not.toHaveProperty('language');
      expect(data).not.toHaveProperty('country');
    });

    it('LIST returns metadata on each summary', async () => {
      mockListTemplates.mockResolvedValue({
        items: [sampleTemplateAggregate({ ...ALL_METADATA }).metadata],
      });
      const res = await listPlatformMain(
        platformEvent({ httpMethod: 'GET', body: null }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.items[0]).toMatchObject(ALL_METADATA);
    });

    it('LIST resolves updatedByName from USER_TABLE and keeps updatedBy', async () => {
      mockGetProfilesByIds.mockResolvedValue(
        new Map([['user-1', { displayName: 'Sumit Kumar' }]]),
      );
      mockListTemplates.mockResolvedValue({
        items: [
          sampleTemplateAggregate({ templateId: 'a', updatedBy: 'user-1' }).metadata,
          sampleTemplateAggregate({ templateId: 'b', updatedBy: 'user-1' }).metadata,
        ],
      });

      const res = await listPlatformMain(
        platformEvent({ httpMethod: 'GET', body: null }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const items = JSON.parse(res.body).data.items;
      expect(items).toHaveLength(2);
      expect(items[0].updatedBy).toBe('user-1');
      expect(items[0].updatedByName).toBe('Sumit Kumar');
      expect(items[1].updatedByName).toBe('Sumit Kumar');
      expect(mockGetProfilesByIds).toHaveBeenCalledTimes(1);
      expect(mockGetProfilesByIds).toHaveBeenCalledWith(['user-1']);
    });

    it('LIST resolves createdByName from USER_TABLE and keeps createdBy', async () => {
      mockGetProfilesByIds.mockResolvedValue(
        new Map([['user-1', { displayName: 'Sumit Kumar' }]]),
      );
      mockListTemplates.mockResolvedValue({
        items: [
          sampleTemplateAggregate({
            templateId: 'a',
            createdBy: 'user-1',
            updatedBy: 'user-2',
          }).metadata,
        ],
      });

      const res = await listPlatformMain(
        platformEvent({ httpMethod: 'GET', body: null }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body).data.items[0];
      expect(item.createdBy).toBe('user-1');
      expect(item.createdByName).toBe('Sumit Kumar');
      expect(mockGetProfilesByIds).toHaveBeenCalledWith(
        expect.arrayContaining(['user-1', 'user-2']),
      );
    });

    it('GET resolves createdByName using the same USER_TABLE enrichment as LIST', async () => {
      const creatorId =
        '88a9a6e052092188660a404a303ca34c992caabfccfc184ca2121fcac2d84e7f';
      mockGetProfilesByIds.mockResolvedValue(
        new Map([[creatorId, { displayName: 'Root Admin' }]]),
      );
      mockGetTemplate.mockResolvedValue(
        sampleTemplateAggregate({
          createdBy: creatorId,
          updatedBy: creatorId,
          status: 'published',
          version: 2,
        }),
      );

      const res = await getPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          pathParameters: { templateId: 'tmpl-1' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;
      expect(data.createdBy).toBe(creatorId);
      expect(data.createdByName).toBe('Root Admin');
      expect(data.updatedBy).toBe(creatorId);
      expect(data.updatedByName).toBe('Root Admin');
      expect(data.steps).toBeDefined();
      expect(mockGetProfilesByIds).toHaveBeenCalledTimes(1);
      expect(mockGetProfilesByIds).toHaveBeenCalledWith([creatorId]);
    });

    it('LIST still succeeds when user lookup fails', async () => {
      mockGetProfilesByIds.mockRejectedValue(new Error('USER_TABLE unavailable'));
      mockListTemplates.mockResolvedValue({
        items: [sampleTemplateAggregate({ updatedBy: 'user-1' }).metadata],
      });

      const res = await listPlatformMain(
        platformEvent({ httpMethod: 'GET', body: null }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body).data.items[0];
      expect(item.updatedBy).toBe('user-1');
      expect(item.updatedByName).toBeUndefined();
    });

    it.each(Object.entries(ALL_METADATA))(
      'LIST filters by %s',
      async (field, value) => {
        mockListTemplates.mockResolvedValue({
          items: [
            sampleTemplateAggregate({
              templateId: 'match',
              ...ALL_METADATA,
            }).metadata,
            sampleTemplateAggregate({
              templateId: 'other',
              ...ALL_METADATA,
              [field]: 'SOMETHING_ELSE',
            }).metadata,
            // Predates the metadata fields, so it cannot match a filter.
            sampleTemplateAggregate({ templateId: 'legacy' }).metadata,
          ],
        });

        const res = await listPlatformMain(
          platformEvent({
            httpMethod: 'GET',
            body: null,
            queryStringParameters: { [field]: value },
          }),
          testLambdaContext(),
        );

        expect(res.statusCode).toBe(200);
        const items = JSON.parse(res.body).data.items;
        expect(items).toHaveLength(1);
        expect(items[0].templateId).toBe('match');
      },
    );

    it('LIST combines a metadata filter with an existing filter', async () => {
      mockListTemplates.mockResolvedValue({
        items: [
          sampleTemplateAggregate({ templateId: 'match', ...ALL_METADATA })
            .metadata,
          sampleTemplateAggregate({
            templateId: 'wrong-type',
            workflowType: 'FORMAL_REVIEW',
            ...ALL_METADATA,
          }).metadata,
        ],
      });

      const res = await listPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          queryStringParameters: {
            workflowType: 'PATIENT_ONBOARDING',
            category: 'CHRONIC',
          },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const items = JSON.parse(res.body).data.items;
      expect(items).toHaveLength(1);
      expect(items[0].templateId).toBe('match');
    });

    it('LIST without metadata filters still returns legacy templates', async () => {
      mockListTemplates.mockResolvedValue({
        items: [sampleTemplateAggregate({ templateId: 'legacy' }).metadata],
      });

      const res = await listPlatformMain(
        platformEvent({ httpMethod: 'GET', body: null }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.items).toHaveLength(1);
    });

    it('LIST rejects a malformed metadata filter → 400', async () => {
      const res = await listPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          queryStringParameters: { category: 'chronic' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(400);
      expect(mockListTemplates).not.toHaveBeenCalled();
    });

    it('clone inherits source metadata and applies overrides', async () => {
      mockGetTemplate.mockResolvedValue(
        sampleTemplateAggregate({ ...ALL_METADATA }),
      );
      mockCreatePlatform.mockResolvedValue(
        sampleTemplateAggregate({ ...ALL_METADATA, country: 'US' }),
      );

      const res = await clonePlatformMain(
        platformEvent({
          pathParameters: { templateId: 'tmpl-1' },
          body: JSON.stringify({ country: 'US' }),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(201);
      expect(mockCreatePlatform).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'CHRONIC',
          shareScope: 'ORGANIZATION',
          language: 'ENGLISH',
          country: 'US',
        }),
      );
    });

    it('publish returns catalog metadata unchanged', async () => {
      mockPublish.mockResolvedValue(
        sampleTemplateAggregate({
          status: 'published',
          recordVersion: 2,
          ...ALL_METADATA,
        }),
      );
      const res = await publishPlatformMain(
        platformEvent({
          pathParameters: { templateId: 'tmpl-1' },
          headers: authHeaders({ 'If-Match': 'W/"1"' }),
          body: JSON.stringify({}),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toMatchObject({
        status: 'published',
        ...ALL_METADATA,
      });
    });
  });

  it('create rejects invalid workflowStage', async () => {
    const res = await createPlatformMain(
      platformEvent({
        body: JSON.stringify(
          sampleCreateTemplateBody({ workflowStage: 'badStage' }),
        ),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('update draft with OCC → 200', async () => {
    mockUpdateDraft.mockResolvedValue(
      sampleTemplateAggregate({ recordVersion: 2 }),
    );
    const res = await updatePlatformMain(
      platformEvent({
        httpMethod: 'PUT',
        path: '/dev/v1/platform/workflow-templates/tmpl-1',
        pathParameters: { templateId: 'tmpl-1' },
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: JSON.stringify({
          templateName: 'Updated',
          description: 'desc',
          program: 'rpm',
          condition: 'htn',
          basedOn: 'platform-base',
          defaultAssignee: {
            assigneeType: 'role',
            assigneeId: 'careCoordinator',
          },
          steps: [sampleTemplateStep()],
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers?.ETag).toBe('W/"2"');
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'tmpl-1',
        expectedRecordVersion: 1,
      }),
    );
  });

  it('update without If-Match → 428', async () => {
    const res = await updatePlatformMain(
      platformEvent({
        httpMethod: 'PUT',
        pathParameters: { templateId: 'tmpl-1' },
        body: JSON.stringify({
          templateName: 'Updated',
          steps: [sampleTemplateStep()],
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(428);
  });

  it('publish → 200', async () => {
    mockPublish.mockResolvedValue(
      sampleTemplateAggregate({ status: 'published', recordVersion: 2 }),
    );
    const res = await publishPlatformMain(
      platformEvent({
        pathParameters: { templateId: 'tmpl-1' },
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe('published');
  });

  it('inactivate → 200', async () => {
    mockInactivate.mockResolvedValue(
      sampleTemplateAggregate({ status: 'inactive', recordVersion: 3 }).metadata,
    );
    const res = await inactivatePlatformMain(
      platformEvent({
        pathParameters: { templateId: 'tmpl-1' },
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe('inactive');
  });

  it('clone → 201 via get + create', async () => {
    mockGetTemplate.mockResolvedValue(sampleTemplateAggregate());
    mockCreatePlatform.mockResolvedValue(
      sampleTemplateAggregate({ templateId: 'tmpl-2', recordVersion: 1 }),
    );
    const res = await clonePlatformMain(
      platformEvent({
        pathParameters: { templateId: 'tmpl-1' },
        body: JSON.stringify({ templateName: 'Cloned' }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(201);
    expect(mockGetTemplate).toHaveBeenCalled();
    expect(mockCreatePlatform).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'Cloned' }),
    );
  });

  describe('clone platform workflow template', () => {
    const SOURCE_ID = 'plt-wf-patient-onboarding';
    const CLONED_ID = 'cloned-wf-ulid';
    const CATALOG = {
      category: 'CHRONIC',
      shareScope: 'ORGANIZATION',
      language: 'ENGLISH',
      country: 'IN',
    };

    function richCloneSource(overrides: Record<string, unknown> = {}) {
      const aggregate = sampleTemplateAggregate({
        templateId: SOURCE_ID,
        templateName: 'Workflow template Onboarding',
        description: 'Onboarding checklist',
        ...CATALOG,
        ...overrides,
      });
      aggregate.steps[0] = {
        ...aggregate.steps[0],
        templateId: SOURCE_ID,
        allowDefer: true,
        linkedAction: { actionCode: 'OPEN_DEMOGRAPHICS' },
      };
      aggregate.checklists[0] = {
        ...aggregate.checklists[0],
        templateId: SOURCE_ID,
        blocksStepCompletion: true,
        linkedAction: { actionCode: 'CONFIRM_NAME' },
        linkedObject: { objectType: 'FORM', objectId: 'form-demographics' },
        assigneeOverride: { assigneeType: 'role', assigneeId: 'nurse' },
      };
      return aggregate;
    }

    function expectCopiedDefinition(
      createArg: Record<string, unknown>,
      source: ReturnType<typeof richCloneSource>,
    ) {
      expect(createArg.templateId).toBeUndefined();
      expect(createArg).toMatchObject({
        templateName: source.metadata.templateName,
        description: source.metadata.description,
        workflowType: source.metadata.workflowType,
        workflowStage: source.metadata.workflowStage,
        ...CATALOG,
        defaultAssignee: source.metadata.defaultAssignee,
      });
      expect(createArg).not.toHaveProperty('status');
      expect(createArg).not.toHaveProperty('version');
      const steps = createArg.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        stepId: 'verifyDemographics',
        name: 'Verify demographics',
        instructions: 'Check ID',
        requirement: 'mandatory',
        allowSkip: false,
        allowDefer: true,
        defaultAssignee: {
          assigneeType: 'role',
          assigneeId: 'careCoordinator',
        },
        linkedAction: { actionCode: 'OPEN_DEMOGRAPHICS' },
      });
      expect(steps[0].checklists).toEqual([
        expect.objectContaining({
          checklistId: 'confirmName',
          itemName: 'Confirm name',
          instruction: 'Match ID',
          required: true,
          allowSkip: false,
          allowDefer: false,
          blocksStepCompletion: true,
          linkedAction: { actionCode: 'CONFIRM_NAME' },
          linkedObject: {
            objectType: 'FORM',
            objectId: 'form-demographics',
          },
          assigneeOverride: { assigneeType: 'role', assigneeId: 'nurse' },
        }),
      ]);
    }

    function expectSourceUnchanged() {
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockInactivate).not.toHaveBeenCalled();
      expect(mockCreateOrg).not.toHaveBeenCalled();
    }

    it.each([
      ['published', 3, 7],
      ['draft', 1, 1],
    ] as const)(
      'duplicate %s template creates a new draft v1 without mutating the source',
      async (status, version, recordVersion) => {
        const source = richCloneSource({ status, version, recordVersion });
        mockGetTemplate.mockResolvedValue(source);
        mockCreatePlatform.mockResolvedValue(
          sampleTemplateAggregate({
            templateId: CLONED_ID,
            templateName: source.metadata.templateName,
            status: 'draft',
            version: 1,
            recordVersion: 1,
            ...CATALOG,
          }),
        );

        const res = await clonePlatformMain(
          platformEvent({
            pathParameters: { templateId: SOURCE_ID },
            body: JSON.stringify({}),
          }),
          testLambdaContext(),
        );

        expect(res.statusCode).toBe(201);
        const data = JSON.parse(res.body).data;
        expect(data.templateId).toBe(CLONED_ID);
        expect(data.templateId).not.toBe(SOURCE_ID);
        expect(data.status).toBe('draft');
        expect(data.version).toBe(1);
        expect(mockGetTemplate).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: 'platform',
            templateId: SOURCE_ID,
          }),
        );
        expectCopiedDefinition(mockCreatePlatform.mock.calls[0][0], source);
        expectSourceUnchanged();
      },
    );

    it('duplicate does not start a patient runtime workflow', async () => {
      mockGetTemplate.mockResolvedValue(richCloneSource());
      mockCreatePlatform.mockResolvedValue(
        sampleTemplateAggregate({ templateId: CLONED_ID, status: 'draft' }),
      );

      const res = await clonePlatformMain(
        platformEvent({
          pathParameters: { templateId: SOURCE_ID },
          body: JSON.stringify({}),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(201);
      expect(mockCreatePlatform).toHaveBeenCalledTimes(1);
      expectSourceUnchanged();
    });
  });

  it('get → 200 strips internal attrs', async () => {
    mockGetTemplate.mockResolvedValue(sampleTemplateAggregate());
    const res = await getPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        pathParameters: { templateId: 'tmpl-1' },
        body: null,
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.templateId).toBe('tmpl-1');
    expect(data.workflowType).toBe('PATIENT_ONBOARDING');
    expect(data.workflowStage).toBe('PATIENT_ONBOARDING');
    expect(data.pk).toBeUndefined();
    expect(data.entityType).toBeUndefined();
  });

  it('list published templates by workflowStage PATIENT_ONBOARDING', async () => {
    mockListTemplates.mockResolvedValue({
      items: [
        sampleTemplateAggregate({
          status: 'published',
          workflowStage: 'PATIENT_ONBOARDING',
        }).metadata,
      ],
    });
    const res = await listPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        body: null,
        queryStringParameters: {
          workflowStage: 'PATIENT_ONBOARDING',
          status: 'published',
        },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.items).toHaveLength(1);
    expect(data.items[0].workflowStage).toBe('PATIENT_ONBOARDING');
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'platform',
        workflowStage: 'PATIENT_ONBOARDING',
        status: 'published',
      }),
    );
  });

  it.each(['FORMAL_REVIEW', 'CLOSURE_REVIEW'] as const)(
    'list published templates by workflowStage %s',
    async (stage) => {
      mockListTemplates.mockResolvedValue({
        items: [
          sampleTemplateAggregate({
            status: 'published',
            workflowStage: stage,
            workflowType: stage,
          }).metadata,
        ],
      });
      const res = await listPlatformMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          queryStringParameters: {
            workflowStage: stage,
            status: 'published',
          },
        }),
        testLambdaContext(),
      );
      expect(res.statusCode).toBe(200);
      expect(mockListTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowStage: stage,
          status: 'published',
        }),
      );
    },
  );

  it('list status=published returns all stages and excludes inactive', async () => {
    mockListTemplates.mockResolvedValue({
      items: [
        sampleTemplateAggregate({
          templateId: 'plt-wf-patient-onboarding',
          status: 'published',
          workflowStage: 'PATIENT_ONBOARDING',
          workflowType: 'PATIENT_ONBOARDING',
        }).metadata,
        sampleTemplateAggregate({
          templateId: 'plt-wf-formal-review',
          status: 'published',
          workflowStage: 'FORMAL_REVIEW',
          workflowType: 'FORMAL_REVIEW',
        }).metadata,
        sampleTemplateAggregate({
          templateId: 'plt-wf-closure-review',
          status: 'published',
          workflowStage: 'CLOSURE_REVIEW',
          workflowType: 'CLOSURE_REVIEW',
        }).metadata,
        sampleTemplateAggregate({
          templateId: 'plt-wf-inactive',
          status: 'inactive',
          workflowStage: 'PATIENT_ONBOARDING',
        }).metadata,
      ],
      nextCursor: 'next-page',
    });
    const res = await listPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        body: null,
        queryStringParameters: { status: 'published' },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.nextCursor).toBe('next-page');
    expect(data.items.map((item: { templateId: string }) => item.templateId)).toEqual(
      [
        'plt-wf-patient-onboarding',
        'plt-wf-formal-review',
        'plt-wf-closure-review',
      ],
    );
    expect(
      data.items.map((item: { workflowStage: string }) => item.workflowStage).sort(),
    ).toEqual(['CLOSURE_REVIEW', 'FORMAL_REVIEW', 'PATIENT_ONBOARDING']);
    expect(
      data.items.every((item: { status: string }) => item.status === 'published'),
    ).toBe(true);
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'platform',
        status: 'published',
        workflowStage: undefined,
      }),
    );
  });

  it('list rejects camelCase workflowStage patientOnboarding', async () => {
    const res = await listPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        body: null,
        queryStringParameters: {
          workflowStage: 'patientOnboarding',
          status: 'published',
        },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(400);
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it('list → 200 with pagination cursor', async () => {
    mockListTemplates.mockResolvedValue({
      items: [sampleTemplateAggregate().metadata],
      nextCursor: 'next-token',
    });
    const res = await listPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        body: null,
        queryStringParameters: {
          workflowStage: 'PATIENT_ONBOARDING',
          status: 'draft',
          limit: '10',
        },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.items).toHaveLength(1);
    expect(data.nextCursor).toBe('next-token');
    expect(mockListTemplates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'platform',
        workflowStage: 'PATIENT_ONBOARDING',
        status: 'draft',
        limit: 10,
      }),
    );
  });

  it('list post-filters by workflowType', async () => {
    mockListTemplates.mockResolvedValue({
      items: [
        sampleTemplateAggregate().metadata,
        sampleTemplateAggregate({
          templateId: 'tmpl-2',
          workflowType: 'FORMAL_REVIEW',
        }).metadata,
      ],
    });
    const res = await listPlatformMain(
      platformEvent({
        httpMethod: 'GET',
        body: null,
        queryStringParameters: { workflowType: 'PATIENT_ONBOARDING' },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.items).toHaveLength(1);
  });

  it('maps VERSION_CONFLICT to 409', async () => {
    mockUpdateDraft.mockRejectedValue(
      new WorkflowTemplateConflictError('mismatch', 'VERSION_CONFLICT'),
    );
    const res = await updatePlatformMain(
      platformEvent({
        httpMethod: 'PUT',
        pathParameters: { templateId: 'tmpl-1' },
        headers: authHeaders({ 'If-Match': 'W/"1"' }),
        body: JSON.stringify({
          templateName: 'Updated',
          steps: [sampleTemplateStep()],
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(409);
  });

  it('org list rejects org mismatch', async () => {
    const res = await listOrgMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        pathParameters: { orgId: 'other-org' },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('care plan mapping get/put/delete', async () => {
    const mapping = {
      organizationId: 'org-1',
      carePlanTemplateId: 'cpt-1',
      workflowStage: 'PATIENT_ONBOARDING',
      workflowTemplateId: 'tmpl-1',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      recordVersion: 1,
      pk: 'ignored',
      sk: 'ignored',
      entityType: 'CarePlanWorkflowMapping',
    };
    mockGetAggregate.mockResolvedValue({
      organizationId: 'org-1',
      carePlanTemplateId: 'cpt-1',
      mappings: [mapping],
      byStage: { PATIENT_ONBOARDING: mapping },
    });
    mockPutMappings.mockResolvedValue([mapping]);
    mockDeleteMapping.mockResolvedValue(undefined);
    mockEnsureOrgCopies.mockImplementation(async ({ mappings }) => mappings);

    const getRes = await getMappingsMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        path: '/dev/v1/organizations/org-1/care-plan-templates/cpt-1/workflow-mappings',
        pathParameters: { orgId: 'org-1', carePlanTemplateId: 'cpt-1' },
      }),
      testLambdaContext(),
    );
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).data.mappings[0].pk).toBeUndefined();

    const putRes = await putMappingsMain(
      orgEvent({
        httpMethod: 'PUT',
        pathParameters: { orgId: 'org-1', carePlanTemplateId: 'cpt-1' },
        body: JSON.stringify({
          mappings: [
            {
              workflowStage: 'PATIENT_ONBOARDING',
              workflowTemplateId: 'tmpl-1',
            },
          ],
        }),
      }),
      testLambdaContext(),
    );
    expect(putRes.statusCode).toBe(200);
    expect(mockPutMappings).toHaveBeenCalledWith(
      expect.objectContaining({
        mappings: [
          expect.objectContaining({
            workflowStage: 'PATIENT_ONBOARDING',
            workflowTemplateId: 'tmpl-1',
          }),
        ],
      }),
    );

    const delRes = await deleteMappingMain(
      orgEvent({
        httpMethod: 'DELETE',
        pathParameters: {
          orgId: 'org-1',
          carePlanTemplateId: 'cpt-1',
          workflowStage: 'PATIENT_ONBOARDING',
        },
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(delRes.statusCode).toBe(200);
    expect(mockDeleteMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowStage: 'PATIENT_ONBOARDING',
        carePlanTemplateId: 'cpt-1',
      }),
    );
  });

  it('care plan mapping PUT remaps platform ids to org copies', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 's2s-internal-token';
    mockEnsureOrgCopies.mockResolvedValue([
      {
        workflowStage: 'PATIENT_ONBOARDING',
        workflowTemplateId: 'org-wf-onboarding',
      },
    ]);
    mockPutMappings.mockResolvedValue([
      {
        organizationId: 'org-target',
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-TARGET',
        workflowStage: 'PATIENT_ONBOARDING',
        workflowTemplateId: 'org-wf-onboarding',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        recordVersion: 1,
        pk: 'ignored',
        sk: 'ignored',
        entityType: 'CarePlanWorkflowMapping',
      },
    ]);

    const putRes = await putMappingsMain(
      orgEvent({
        httpMethod: 'PUT',
        headers: { Authorization: 'Bearer s2s-internal-token' },
        pathParameters: {
          orgId: 'org-target',
          carePlanTemplateId: 'HTN-CARE-PLAN-ORG-TARGET',
        },
        body: JSON.stringify({
          mappings: [
            {
              workflowStage: 'PATIENT_ONBOARDING',
              workflowTemplateId: 'plt-wf-patient-onboarding',
            },
          ],
        }),
      }),
      testLambdaContext(),
    );

    expect(putRes.statusCode).toBe(200);
    expect(mockEnsureOrgCopies).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-target',
        mappings: [
          {
            workflowStage: 'PATIENT_ONBOARDING',
            workflowTemplateId: 'plt-wf-patient-onboarding',
          },
        ],
      }),
    );
    expect(mockPutMappings).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-target',
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-TARGET',
        createdBy: 'system:internal-service',
        mappings: [
          {
            workflowStage: 'PATIENT_ONBOARDING',
            workflowTemplateId: 'org-wf-onboarding',
          },
        ],
      }),
    );
    expect(JSON.parse(putRes.body).data.mappings[0].workflowTemplateId).toBe(
      'org-wf-onboarding',
    );
    delete process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-service-token';
  });

  it('S2S from-platform remaps platform ids to org copies', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 's2s-internal-token';
    mockEnsureOrgCopies.mockResolvedValue([
      {
        workflowStage: 'PATIENT_ONBOARDING',
        workflowTemplateId: 'org-wf-onboarding',
      },
    ]);

    const res = await ensureFromPlatformMain(
      orgEvent({
        pathParameters: { orgId: 'org-target' },
        headers: { Authorization: 'Bearer s2s-internal-token' },
        body: JSON.stringify({
          mappings: [
            {
              workflowStage: 'PATIENT_ONBOARDING',
              workflowTemplateId: 'plt-wf-patient-onboarding',
            },
          ],
        }),
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.mappings).toEqual([
      {
        workflowStage: 'PATIENT_ONBOARDING',
        workflowTemplateId: 'org-wf-onboarding',
      },
    ]);
    expect(mockEnsureOrgCopies).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-target',
        createdBy: 'system:internal-service',
        mappings: [
          {
            workflowStage: 'PATIENT_ONBOARDING',
            workflowTemplateId: 'plt-wf-patient-onboarding',
          },
        ],
      }),
    );
    expect(mockCreatePlatform).not.toHaveBeenCalled();
    expect(mockUpdateDraft).not.toHaveBeenCalled();
    delete process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-service-token';
  });

  it('from-platform rejects a caller JWT (internal S2S only)', async () => {
    const res = await ensureFromPlatformMain(
      orgEvent({
        pathParameters: { orgId: 'org-1' },
        body: JSON.stringify({
          mappings: [
            {
              workflowStage: 'PATIENT_ONBOARDING',
              workflowTemplateId: 'plt-wf-patient-onboarding',
            },
          ],
        }),
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(403);
    expect(mockEnsureOrgCopies).not.toHaveBeenCalled();
  });

  it('GET mappings heals stored platform ids to org copies', async () => {
    const stored = {
      organizationId: 'org-1',
      carePlanTemplateId: 'cpt-1',
      workflowStage: 'PATIENT_ONBOARDING',
      workflowTemplateId: '01M0HCTV720HF587W32MJPK6Q2',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      recordVersion: 1,
      pk: 'ignored',
      sk: 'ignored',
      entityType: 'CarePlanWorkflowMapping',
    };
    const healed = {
      ...stored,
      workflowTemplateId: 'org-wf-onboarding',
      recordVersion: 2,
    };
    mockGetAggregate.mockResolvedValue({
      organizationId: 'org-1',
      carePlanTemplateId: 'cpt-1',
      mappings: [stored],
      byStage: { PATIENT_ONBOARDING: stored },
    });
    mockEnsureOrgCopies.mockResolvedValue([
      {
        workflowStage: 'PATIENT_ONBOARDING',
        workflowTemplateId: 'org-wf-onboarding',
      },
    ]);
    mockPutMappings.mockResolvedValue([healed]);

    const res = await getMappingsMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        path: '/dev/v1/organizations/org-1/care-plan-templates/cpt-1/workflow-mappings',
        pathParameters: { orgId: 'org-1', carePlanTemplateId: 'cpt-1' },
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.mappings[0].workflowTemplateId).toBe(
      'org-wf-onboarding',
    );
    expect(mockPutMappings).toHaveBeenCalledWith(
      expect.objectContaining({
        mappings: [
          {
            workflowStage: 'PATIENT_ONBOARDING',
            workflowTemplateId: 'org-wf-onboarding',
          },
        ],
      }),
    );
  });

  it('GET mappings does not swallow fork persistence failures', async () => {
    mockGetAggregate.mockResolvedValue({
      organizationId: 'org-1',
      carePlanTemplateId: 'cpt-1',
      mappings: [
        {
          organizationId: 'org-1',
          carePlanTemplateId: 'cpt-1',
          workflowStage: 'PATIENT_ONBOARDING',
          workflowTemplateId: '01M0HCTV720HF587W32MJPK6Q2',
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          recordVersion: 1,
          pk: 'ignored',
          sk: 'ignored',
          entityType: 'CarePlanWorkflowMapping',
        },
      ],
      byStage: {},
    });
    mockEnsureOrgCopies.mockRejectedValue(
      Object.assign(new Error('Workflow template was not persisted'), {
        statusCode: 500,
        code: 'WORKFLOW_TEMPLATE_NOT_PERSISTED',
      }),
    );

    const res = await getMappingsMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        path: '/dev/v1/organizations/org-1/care-plan-templates/cpt-1/workflow-mappings',
        pathParameters: { orgId: 'org-1', carePlanTemplateId: 'cpt-1' },
      }),
      testLambdaContext(),
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe(
      'WORKFLOW_TEMPLATE_NOT_PERSISTED',
    );
    expect(mockPutMappings).not.toHaveBeenCalled();
  });

  it('Org Admin GET/PUT/publish use the org template id and do not touch platform', async () => {
    const orgId = 'org-wf-onboarding';
    const orgAggregate = sampleTemplateAggregate({
      scope: 'organization',
      organizationId: 'org-1',
      templateId: orgId,
      platformTemplateId: '01M0HCTV720HF587W32MJPK6Q2',
      recordVersion: 2,
    });
    mockGetTemplate.mockResolvedValue(orgAggregate);
    mockUpdateDraft.mockResolvedValue({
      ...orgAggregate,
      metadata: { ...orgAggregate.metadata, recordVersion: 3 },
    });
    mockPublish.mockResolvedValue({
      ...orgAggregate,
      metadata: { ...orgAggregate.metadata, status: 'published', recordVersion: 4 },
    });
    mockInactivate.mockResolvedValue({
      ...orgAggregate,
      metadata: { ...orgAggregate.metadata, status: 'inactive', recordVersion: 5 },
    });

    const getRes = await getOrgMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        pathParameters: { orgId: 'org-1', templateId: orgId },
      }),
      testLambdaContext(),
    );
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body).data;
    expect(getBody.templateId).toBe(orgId);
    expect(getBody.orgTemplateId).toBe(orgId);
    expect(getBody.platformTemplateId).toBe('01M0HCTV720HF587W32MJPK6Q2');

    const putRes = await updateOrgMain(
      orgEvent({
        httpMethod: 'PUT',
        pathParameters: { orgId: 'org-1', templateId: orgId },
        headers: authHeaders({ 'If-Match': 'W/"2"' }),
        body: JSON.stringify({
          templateName: 'Org customized onboarding',
          steps: [sampleTemplateStep()],
        }),
      }),
      testLambdaContext(),
    );
    expect(putRes.statusCode).toBe(200);
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'organization',
        organizationId: 'org-1',
        templateId: orgId,
      }),
    );
    expect(mockCreatePlatform).not.toHaveBeenCalled();

    const publishRes = await publishOrgMain(
      orgEvent({
        httpMethod: 'POST',
        pathParameters: { orgId: 'org-1', templateId: orgId },
        headers: authHeaders({ 'If-Match': 'W/"3"' }),
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(publishRes.statusCode).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'organization',
        organizationId: 'org-1',
        templateId: orgId,
      }),
    );

    const inactivateRes = await inactivateOrgMain(
      orgEvent({
        httpMethod: 'POST',
        pathParameters: { orgId: 'org-1', templateId: orgId },
        headers: authHeaders({ 'If-Match': 'W/"4"' }),
        body: JSON.stringify({}),
      }),
      testLambdaContext(),
    );
    expect(inactivateRes.statusCode).toBe(200);
    expect(mockInactivate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'organization',
        organizationId: 'org-1',
        templateId: orgId,
      }),
    );
  });

  it('Org GET with a platform template id does not search the platform partition', async () => {
    mockGetTemplate.mockResolvedValue(null);
    const res = await getOrgMain(
      orgEvent({
        httpMethod: 'GET',
        body: null,
        pathParameters: {
          orgId: 'org-1',
          templateId: '01M0HCTV720HF587W32MJPK6Q2',
        },
      }),
      testLambdaContext(),
    );
    expect(res.statusCode).toBe(404);
    expect(mockGetTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'organization',
        organizationId: 'org-1',
        templateId: '01M0HCTV720HF587W32MJPK6Q2',
      }),
    );
  });

  describe('platform template history', () => {
    it('GET history → 200 paginated items', async () => {
      mockListHistory.mockResolvedValue({
        items: [
          {
            historyId: '01HIST1',
            templateId: 'tmpl-1',
            scope: 'platform',
            action: 'template.created',
            actorId: 'user-1',
            actorType: 'user',
            timestamp: '2026-08-25T09:00:00.000Z',
            after: { version: 1, status: 'draft', templateName: 'Standard Onboarding Template' },
          },
          {
            historyId: '01HIST2',
            templateId: 'tmpl-1',
            scope: 'platform',
            action: 'template.published',
            actorId: 'user-1',
            actorType: 'user',
            timestamp: '2026-08-25T10:00:00.000Z',
            before: { version: 1, status: 'draft' },
            after: { version: 2, status: 'published' },
          },
        ],
        nextCursor: undefined,
      });

      const res = await listPlatformHistoryMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          path: '/dev/v1/platform/workflow-templates/tmpl-1/history',
          pathParameters: { templateId: 'tmpl-1' },
          queryStringParameters: { limit: '50' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items[0].action).toBe('template.created');
      expect(body.data.items[0].reason).toBeNull();
      expect(body.data.items[1].action).toBe('template.published');
      expect(body.data.nextCursor).toBeNull();
      expect(mockListHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'platform',
          templateId: 'tmpl-1',
          limit: 50,
        }),
      );
    });

    it('GET history → 404 when template missing', async () => {
      const { WorkflowTemplateNotFoundError } = jest.requireActual<
        typeof import('@api-hub/workflow-runtime-core')
      >('@api-hub/workflow-runtime-core');
      mockListHistory.mockRejectedValue(
        new WorkflowTemplateNotFoundError('Workflow template tmpl-missing not found'),
      );

      const res = await listPlatformHistoryMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          path: '/dev/v1/platform/workflow-templates/tmpl-missing/history',
          pathParameters: { templateId: 'tmpl-missing' },
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(404);
    });

    it('GET history rejects invalid limit', async () => {
      const res = await listPlatformHistoryMain(
        platformEvent({
          httpMethod: 'GET',
          body: null,
          path: '/dev/v1/platform/workflow-templates/tmpl-1/history',
          pathParameters: { templateId: 'tmpl-1' },
          queryStringParameters: { limit: '0' },
        }),
        testLambdaContext(),
      );
      expect(res.statusCode).toBe(400);
      expect(mockListHistory).not.toHaveBeenCalled();
    });

    it('clone creates via createPlatformTemplate only (no source history mutation)', async () => {
      mockGetTemplate.mockResolvedValue(sampleTemplateAggregate());
      mockCreatePlatform.mockResolvedValue(
        sampleTemplateAggregate({ templateId: 'tmpl-cloned' }),
      );

      const res = await clonePlatformMain(
        platformEvent({
          httpMethod: 'POST',
          path: '/dev/v1/platform/workflow-templates/tmpl-1/clone',
          pathParameters: { templateId: 'tmpl-1' },
          body: JSON.stringify({ templateName: 'Cloned' }),
        }),
        testLambdaContext(),
      );

      expect(res.statusCode).toBe(201);
      expect(mockGetTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'tmpl-1', scope: 'platform' }),
      );
      expect(mockCreatePlatform).toHaveBeenCalled();
      expect(mockUpdateDraft).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockListHistory).not.toHaveBeenCalled();
    });
  });
});
