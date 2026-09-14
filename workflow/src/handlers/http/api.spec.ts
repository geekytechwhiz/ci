import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  dispatchHttpEvent,
  HTTP_ROUTE_DEFS,
  matchHttpRoute,
  routeKey,
} from './http-router';
import { testLambdaContext } from '../../__tests__/handler-test-utils';

const ROOT = join(__dirname, '../../..');

function loadServerlessYaml(): string {
  return readFileSync(join(ROOT, 'serverless.yml'), 'utf8').replace(/\r\n/g, '\n');
}

function extractApiHttpEvents(yaml: string): Array<{ method: string; path: string }> {
  const apiStart = yaml.indexOf('\n  api:\n');
  expect(apiStart).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(apiStart + 1);
  const nextFn = rest.search(/\n  [a-zA-Z][a-zA-Z0-9]*:\n/);
  const apiBlock = nextFn < 0 ? rest : rest.slice(0, nextFn);

  return apiBlock
    .split(/\n      - http:\n/)
    .slice(1)
    .map((block) => {
      const path = block.match(/path:\s*(.+)/)?.[1]?.trim();
      const method = block.match(/method:\s*(.+)/)?.[1]?.trim()?.toUpperCase();
      if (!path || !method) {
        throw new Error(`Invalid http event block:\n${block.slice(0, 120)}`);
      }
      return { method, path };
    });
}

function gatewayEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/health',
    resource: '/health',
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    body: null,
    ...overrides,
  } as APIGatewayProxyEvent;
}

describe('POC HTTP dispatcher router', () => {
  it('registers 68 HTTP routes matching serverless.yml', () => {
    const yamlRoutes = extractApiHttpEvents(loadServerlessYaml());
    expect(yamlRoutes).toHaveLength(68);
    expect(HTTP_ROUTE_DEFS).toHaveLength(68);

    const yamlKeys = yamlRoutes
      .map((r) => {
        const path = r.path.startsWith('/') ? r.path : `/${r.path}`;
        return `${r.method} ${path}`;
      })
      .sort();
    const codeKeys = HTTP_ROUTE_DEFS.map((r) => routeKey(r)).sort();
    expect(codeKeys).toEqual(yamlKeys);
  });

  it('matches every route by API Gateway resource template', () => {
    for (const route of HTTP_ROUTE_DEFS) {
      const matched = matchHttpRoute(
        gatewayEvent({
          httpMethod: route.method,
          resource: route.resource,
          path: route.resource.replace(/\{[^}]+\}/g, 'id-1'),
        }),
      );
      expect(matched).toEqual(route);
    }
  });

  it('matches concrete request paths when resource is absent', () => {
    const matched = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'POST',
        resource: undefined,
        path: '/dev/v1/workflows/wf-1/steps/step-1/checklists/cl-1/complete',
      }),
    );
    expect(matched?.resource).toBe(
      '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/complete',
    );
  });

  it('prefers the longest matching path template', () => {
    const history = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'GET',
        resource: undefined,
        path: '/v1/platform/workflow-templates/tmpl-1/history',
      }),
    );
    expect(history?.resource).toBe(
      '/v1/platform/workflow-templates/{templateId}/history',
    );

    const getTemplate = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'GET',
        resource: undefined,
        path: '/v1/platform/workflow-templates/tmpl-1',
      }),
    );
    expect(getTemplate?.resource).toBe(
      '/v1/platform/workflow-templates/{templateId}',
    );
  });

  it('matches static collection paths instead of parameterized siblings', () => {
    const fromPlatform = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'POST',
        resource: undefined,
        path: '/v1/organizations/org-1/workflow-templates/from-platform',
      }),
    );
    expect(fromPlatform?.resource).toBe(
      '/v1/organizations/{orgId}/workflow-templates/from-platform',
    );
  });

  it('uses requestContext.httpMethod and resourcePath when top-level fields are empty', () => {
    const matched = matchHttpRoute(
      gatewayEvent({
        httpMethod: '',
        resource: '',
        path: '',
        requestContext: {
          httpMethod: 'GET',
          resourcePath: '/v1/dashboard/queue',
        } as APIGatewayProxyEvent['requestContext'],
      }),
    );
    expect(matched?.resource).toBe('/v1/dashboard/queue');
  });

  it('returns 404 when no route matches', async () => {
    const result = await dispatchHttpEvent(
      gatewayEvent({
        httpMethod: 'GET',
        resource: '/v1/does-not-exist',
        path: '/v1/does-not-exist',
      }),
      testLambdaContext(),
      () => undefined,
    );

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No handler for this route',
      },
    });
  });

  it('returns 404 when method has no routes', async () => {
    const result = await dispatchHttpEvent(
      gatewayEvent({
        httpMethod: 'PATCH',
        resource: '/health',
        path: '/health',
      }),
      testLambdaContext(),
      () => undefined,
    );
    expect(result.statusCode).toBe(404);
  });

  it('dispatches to the bound handler for a matched route', async () => {
    const result = await dispatchHttpEvent(
      gatewayEvent({
        httpMethod: 'GET',
        resource: '/health',
        path: '/health',
      }),
      testLambdaContext(),
      () =>
        async () =>
          ({
            statusCode: 200,
            body: JSON.stringify({ status: 'healthy' }),
          }) as APIGatewayProxyResult,
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'healthy' });
  });

  it('returns 404 when the bound handler is missing or returns undefined', async () => {
    const missing = await dispatchHttpEvent(
      gatewayEvent({ httpMethod: 'GET', resource: '/health', path: '/health' }),
      testLambdaContext(),
      () => undefined,
    );
    expect(missing.statusCode).toBe(404);

    const empty = await dispatchHttpEvent(
      gatewayEvent({ httpMethod: 'GET', resource: '/health', path: '/health' }),
      testLambdaContext(),
      () => async () => undefined,
    );
    expect(empty.statusCode).toBe(404);
  });

  it('matches a concrete resource path against the template', () => {
    const matched = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'GET',
        resource: '/v1/workflows/wf-99',
        path: undefined,
      }),
    );
    expect(matched?.resource).toBe('/v1/workflows/{workflowId}');
  });

  it('returns undefined when method, resource, and path are all absent', () => {
    const matched = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'GET',
        resource: undefined,
        path: undefined,
        requestContext: {} as APIGatewayProxyEvent['requestContext'],
      }),
    );
    expect(matched).toBeUndefined();
  });

  it('normalizes trailing slashes and missing leading slashes', () => {
    const matched = matchHttpRoute(
      gatewayEvent({
        httpMethod: 'GET',
        resource: 'v1/dashboard/queue/',
        path: undefined,
      }),
    );
    expect(matched?.resource).toBe('/v1/dashboard/queue');
  });
});
