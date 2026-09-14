/**
 * Locks API Gateway auth for Workflow Service POC routes.
 *
 * The shared custom authorizer Lambda (`*_global_user_package_custom_authorization`)
 * is not deployed in this account, so HTTP events must not reference it — that
 * resource (`CommonUnderscoreauthorizerLambdaPermissionApiGateway`) fails CREATE.
 *
 * AWS_IAM on a route causes API Gateway to parse `Authorization: Bearer <JWT>`
 * as SigV4 and return:
 * "Invalid key=value pair (missing equal-sign) in Authorization header..."
 *
 * Application JWT/org helpers in src/utils/helpers.ts are not API Gateway
 * infrastructure and are intentionally left in place.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const LEGACY_AUTHORIZER_FN = 'global_user_package_custom_authorization';
const LEGACY_AUTHORIZER_PERMISSION = 'CommonUnderscoreauthorizerLambdaPermissionApiGateway';

const ACTIVE_CONFIG_DIRS = [
  ROOT,
  join(ROOT, 'config'),
  join(ROOT, 'config/permissions'),
  join(ROOT, 'config/resources'),
  join(ROOT, 'data'),
  join(ROOT, 'infrastructure'),
];

function loadServerlessYaml(): string {
  return readFileSync(join(ROOT, 'serverless.yml'), 'utf8').replace(/\r\n/g, '\n');
}

function extractApiFunctionBlock(yaml: string): string {
  const fnMarker = '\n  api:\n';
  const start = yaml.indexOf(fnMarker);
  if (start < 0) {
    throw new Error('Function api not found in serverless.yml');
  }
  const rest = yaml.slice(start + 1);
  const nextFn = rest.search(/\n  [a-zA-Z][a-zA-Z0-9]*:\n/);
  return nextFn < 0 ? rest : rest.slice(0, nextFn);
}

function extractHttpEventByPath(apiBlock: string, pathSnippet: string): string {
  const idx = apiBlock.indexOf(pathSnippet);
  if (idx < 0) {
    throw new Error(`HTTP path ${pathSnippet} not found on api Lambda`);
  }
  const fromEvent = apiBlock.lastIndexOf('- http:', idx);
  if (fromEvent < 0) {
    throw new Error(`http event for ${pathSnippet} not found`);
  }
  const rest = apiBlock.slice(fromEvent);
  const next = rest.search(/\n      - http:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function extractAllHttpEvents(
  apiBlock: string,
): Array<{ method: string; path: string; block: string }> {
  const chunks = apiBlock.split('\n      - http:\n').slice(1);
  return chunks.map((chunk) => {
    const block = `      - http:\n${chunk}`;
    return {
      method: /method:\s*(\S+)/.exec(chunk)?.[1] ?? '',
      path: /path:\s*(\S+)/.exec(chunk)?.[1] ?? '',
      block,
    };
  });
}

function listActiveConfigFiles(): string[] {
  const files: string[] = [];
  for (const dir of ACTIVE_CONFIG_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      if (!/\.(yml|yaml|json)$/.test(name)) continue;
      if (name === 'packaged.yaml' || name === 'serverless-state.json') continue;
      files.push(full);
    }
  }
  files.push(join(ROOT, 'package.json'));
  return files;
}

function loadGeneratedTemplate():
  | { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> }
  | undefined {
  const candidates = [
    join(ROOT, '.serverless/cloudformation-template-update-stack.json'),
    join(ROOT, 'packaged.yaml'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    try {
      return JSON.parse(raw) as {
        Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

describe('workflow-service API Gateway auth config', () => {
  const yaml = loadServerlessYaml();
  const apiBlock = extractApiFunctionBlock(yaml);
  const httpEvents = extractAllHttpEvents(apiBlock);

  it('defines a single api HTTP Lambda', () => {
    expect(yaml).toMatch(/handler:\s*src\/handlers\/http\/api\.main/);
    expect(yaml).not.toMatch(/\n  health:\n/);
    expect(yaml).not.toMatch(/\n  completeChecklist:\n/);
    expect(yaml).not.toMatch(/\n  createPlatformWorkflowTemplate:\n/);
  });

  it('does not attach the missing custom authorization Lambda', () => {
    expect(yaml).not.toMatch(/securedAuthorizer:\s*&securedAuthorizer/);
    expect(yaml).not.toMatch(/name:\s*common_authorizer/);
    expect(yaml).not.toMatch(new RegExp(LEGACY_AUTHORIZER_FN));
    expect(yaml).not.toMatch(/authorizer:\s*\*securedAuthorizer/);
    expect(yaml).not.toMatch(/authorizer:\s*aws_iam/i);
    expect(yaml).not.toMatch(/authorizationType:\s*AWS_IAM/);
  });

  it('has no API Gateway authorizer on any HTTP event', () => {
    expect(httpEvents.length).toBeGreaterThan(50);
    for (const event of httpEvents) {
      expect(event.path).toBeTruthy();
      expect(event.method).toBeTruthy();
      expect(event.block).not.toMatch(/authorizer:/);
      expect(event.block).not.toMatch(/AWS_IAM/);
      expect(event.block).not.toMatch(new RegExp(LEGACY_AUTHORIZER_FN));
    }
  });

  it.each([
    ['completeChecklist', 'checklists/{checklistId}/complete'],
    ['startChecklist', 'checklists/{checklistId}/start'],
    ['skipChecklist', 'checklists/{checklistId}/skip'],
    ['deferChecklist', 'checklists/{checklistId}/defer'],
    ['blockChecklist', 'checklists/{checklistId}/block'],
    ['getWorkflowWorkbench', 'workbench'],
  ])('%s http event has no custom authorizer and is not AWS_IAM', (_label, pathSnippet) => {
    const block = extractHttpEventByPath(apiBlock, pathSnippet);
    expect(block).toContain(pathSnippet);
    expect(block).not.toMatch(/authorizer:/);
    expect(block).not.toMatch(/AWS_IAM/);
  });

  it('does not reference the legacy authorizer in active Workflow Service config', () => {
    const hits: string[] = [];
    for (const file of listActiveConfigFiles()) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(LEGACY_AUTHORIZER_FN) || text.includes('common_authorizer')) {
        hits.push(relative(ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('packaged CloudFormation auth (when present)', () => {
  it('does not create common_authorizer Lambda permission or AWS_IAM methods', () => {
    const template = loadGeneratedTemplate();
    if (!template) {
      return;
    }

    const raw = JSON.stringify(template);
    expect(raw).not.toContain(LEGACY_AUTHORIZER_FN);
    expect(raw).not.toContain(LEGACY_AUTHORIZER_PERMISSION);

    const authorizerResources = Object.keys(template.Resources ?? {}).filter((key) =>
      key.includes('CommonUnderscoreauthorizer'),
    );
    expect(authorizerResources).toEqual([]);

    const customAuthorizers = Object.entries(template.Resources ?? {}).filter(
      ([, r]) => r.Type === 'AWS::ApiGateway::Authorizer',
    );
    expect(customAuthorizers).toEqual([]);

    const iamMethods = Object.entries(template.Resources ?? {}).filter(
      ([, r]) =>
        r.Type === 'AWS::ApiGateway::Method' &&
        r.Properties?.AuthorizationType === 'AWS_IAM',
    );
    expect(iamMethods).toEqual([]);

    const authorizerPermissions = Object.entries(template.Resources ?? {}).filter(
      ([, r]) =>
        r.Type === 'AWS::Lambda::Permission' &&
        JSON.stringify(r.Properties ?? {}).includes(LEGACY_AUTHORIZER_FN),
    );
    expect(authorizerPermissions).toEqual([]);
  });
});
