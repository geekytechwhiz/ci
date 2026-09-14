import type { MiddlewarePipelineEvent } from '@api-hub/middleware';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

export function bearerToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `Bearer header.${encoded}.signature`;
}

export function testLambdaContext(): Context {
  return {
    awsRequestId: 'test-aws-request-id',
    getRemainingTimeInMillis: () => 30000,
  } as unknown as Context;
}

export function setupHandlerTestEnv(): { restore: () => void } {
  process.env.ERROR_MESSAGES_CDN_URL =
    process.env.ERROR_MESSAGES_CDN_URL ?? 'https://d2p9v61861q1ox.cloudfront.net';
  process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
  process.env.WORKFLOW_TABLE = process.env.WORKFLOW_TABLE ?? 'workflow-service-dev';
  process.env.INTERNAL_SERVICE_TOKEN =
    process.env.INTERNAL_SERVICE_TOKEN ?? 'test-internal-service-token';

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  return {
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

export function authHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: bearerToken({
      'custom:organizationID': 'org-1',
      'custom:userID': 'user-1',
    }),
    ...overrides,
  };
}

export function baseEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
): MiddlewarePipelineEvent {
  return {
    httpMethod: 'POST',
    path: '/dev/v1/workflows',
    pathParameters: null,
    queryStringParameters: null,
    headers: authHeaders(),
    body: null,
    ...overrides,
  } as unknown as MiddlewarePipelineEvent;
}

export function sampleStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 'verifyDemographics',
    name: 'Verify demographics',
    instructions: 'Check ID',
    requirement: 'mandatory',
    allowSkip: false,
    allowDefer: false,
    condition: null,
    sortOrder: 1,
    defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
    ...overrides,
  };
}

export function sampleCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    workflowType: 'PATIENT_ONBOARDING',
    name: 'Standard Onboarding',
    description: 'desc',
    defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
    steps: [sampleStep()],
    ...overrides,
  };
}

export function sampleTemplateChecklist(
  overrides: Record<string, unknown> = {},
) {
  return {
    checklistId: 'confirmName',
    itemName: 'Confirm name',
    instruction: 'Match ID',
    required: true,
    allowSkip: false,
    allowDefer: false,
    active: true,
    sortOrder: 1,
    ...overrides,
  };
}

export function sampleTemplateStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 'verifyDemographics',
    name: 'Verify demographics',
    instructions: 'Check ID',
    requirement: 'mandatory',
    allowSkip: false,
    allowDefer: false,
    condition: null,
    sortOrder: 1,
    defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
    checklists: [sampleTemplateChecklist()],
    ...overrides,
  };
}

export function sampleCreateTemplateBody(
  overrides: Record<string, unknown> = {},
) {
  return {
    templateName: 'Standard Onboarding Template',
    workflowType: 'PATIENT_ONBOARDING',
    workflowStage: 'PATIENT_ONBOARDING',
    description: 'desc',
    program: 'rpm',
    condition: 'htn',
    basedOn: 'platform-base',
    defaultAssignee: { assigneeType: 'role', assigneeId: 'careCoordinator' },
    steps: [sampleTemplateStep()],
    ...overrides,
  };
}
