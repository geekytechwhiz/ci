/**
 * HTTP method + resource matching for the POC single API Lambda.
 * Handler bindings live in api.ts so tests can import this module without
 * loading every business handler.
 */
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';

export type HttpRouteDef = {
  method: string;
  /** API Gateway resource template, leading slash, `{param}` placeholders. */
  resource: string;
};

export function resourceTemplate(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const HTTP_ROUTE_DEFS: readonly HttpRouteDef[] = (
  [
    { method: 'GET', resource: '/health' },
    { method: 'POST', resource: '/v1/platform/workflow-templates' },
    { method: 'PUT', resource: '/v1/platform/workflow-templates/{templateId}' },
    {
      method: 'POST',
      resource: '/v1/platform/workflow-templates/{templateId}/publish',
    },
    {
      method: 'POST',
      resource: '/v1/platform/workflow-templates/{templateId}/inactivate',
    },
    {
      method: 'POST',
      resource: '/v1/platform/workflow-templates/{templateId}/clone',
    },
    { method: 'GET', resource: '/v1/platform/workflow-templates/{templateId}' },
    {
      method: 'GET',
      resource: '/v1/platform/workflow-templates/{templateId}/history',
    },
    { method: 'GET', resource: '/v1/platform/workflow-templates' },
    { method: 'POST', resource: '/v1/organizations/{orgId}/workflow-templates' },
    {
      method: 'PUT',
      resource: '/v1/organizations/{orgId}/workflow-templates/{templateId}',
    },
    {
      method: 'POST',
      resource: '/v1/organizations/{orgId}/workflow-templates/{templateId}/publish',
    },
    {
      method: 'POST',
      resource:
        '/v1/organizations/{orgId}/workflow-templates/{templateId}/inactivate',
    },
    {
      method: 'POST',
      resource: '/v1/organizations/{orgId}/workflow-templates/{templateId}/clone',
    },
    {
      method: 'GET',
      resource: '/v1/organizations/{orgId}/workflow-templates/{templateId}',
    },
    { method: 'GET', resource: '/v1/organizations/{orgId}/workflow-templates' },
    {
      method: 'POST',
      resource: '/v1/organizations/{orgId}/workflow-templates/from-platform',
    },
    {
      method: 'POST',
      resource:
        '/v1/organizations/{orgId}/workflow-templates/clone-for-care-plan',
    },
    {
      method: 'POST',
      resource: '/v1/organizations/{orgId}/workflow-templates/publish-mapped',
    },
    {
      method: 'POST',
      resource: '/v1/organizations/{orgId}/care-plan-creation-sessions',
    },
    {
      method: 'GET',
      resource:
        '/v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}',
    },
    {
      method: 'DELETE',
      resource:
        '/v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}',
    },
    {
      method: 'POST',
      resource:
        '/v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/finalize',
    },
    {
      method: 'POST',
      resource:
        '/v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/reserve-care-plan',
    },
    {
      method: 'POST',
      resource:
        '/v1/organizations/{orgId}/care-plan-creation-sessions/{creationSessionId}/publish-workflows',
    },
    {
      method: 'GET',
      resource:
        '/v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings',
    },
    {
      method: 'PUT',
      resource:
        '/v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings',
    },
    {
      method: 'DELETE',
      resource:
        '/v1/organizations/{orgId}/care-plan-templates/{carePlanTemplateId}/workflow-mappings/{workflowStage}',
    },
    { method: 'POST', resource: '/v1/workflows' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/start' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/assign' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/wait' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/block' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/resume' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/complete' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/cancel' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps/{stepId}/start' },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/complete',
    },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps/{stepId}/skip' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps/{stepId}/wait' },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps/{stepId}/block' },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/resume',
    },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps/{stepId}/defer' },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/cancel',
    },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/assign',
    },
    { method: 'POST', resource: '/v1/workflows/{workflowId}/steps' },
    { method: 'DELETE', resource: '/v1/workflows/{workflowId}/steps/{stepId}' },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists',
    },
    {
      method: 'DELETE',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}',
    },
    {
      method: 'GET',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}',
    },
    { method: 'GET', resource: '/v1/workflows/{workflowId}/checklists' },
    {
      method: 'GET',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists',
    },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/start',
    },
    {
      method: 'POST',
      resource:
        '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/complete',
    },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/skip',
    },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/defer',
    },
    {
      method: 'POST',
      resource: '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/block',
    },
    {
      method: 'POST',
      resource:
        '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/resume',
    },
    {
      method: 'POST',
      resource:
        '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/cancel',
    },
    {
      method: 'POST',
      resource:
        '/v1/workflows/{workflowId}/steps/{stepId}/checklists/{checklistId}/assign',
    },
    { method: 'GET', resource: '/v1/workflows/{workflowId}' },
    { method: 'GET', resource: '/v1/workflows/{workflowId}/history' },
    { method: 'GET', resource: '/v1/workflows/{workflowId}/notes' },
    { method: 'GET', resource: '/v1/workflows/{workflowId}/evidence' },
    { method: 'GET', resource: '/v1/workflows' },
    { method: 'GET', resource: '/v1/dashboard/queue' },
    { method: 'GET', resource: '/v1/workflows/{workflowId}/workbench' },
    {
      method: 'GET',
      resource: '/v1/workflows/{workflowId}/completion-readiness',
    },
  ] satisfies Array<{ method: string; resource: string }>
).map((route) => ({
  method: route.method.toUpperCase(),
  resource: resourceTemplate(route.resource),
}));

const STAGE_PREFIX = /^\/(?:dev|stg|prd|test|local)(?=\/)/i;

export function routeKey(route: HttpRouteDef): string {
  return `${route.method} ${route.resource}`;
}

export function normalizeResource(value: string): string {
  let path = value.trim();
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  path = path.replace(STAGE_PREFIX, '');
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

function eventMethod(event: APIGatewayProxyEvent): string {
  const method =
    event.httpMethod ||
    (event.requestContext as { httpMethod?: string } | undefined)?.httpMethod ||
    '';
  return method.toUpperCase();
}

function eventResourceTemplate(event: APIGatewayProxyEvent): string | undefined {
  const resource = event.resource?.trim();
  if (resource) {
    return normalizeResource(resource);
  }
  const contextResource = (
    event.requestContext as { resourcePath?: string } | undefined
  )?.resourcePath?.trim();
  if (contextResource) {
    return normalizeResource(contextResource);
  }
  return undefined;
}

function eventRequestPath(event: APIGatewayProxyEvent): string | undefined {
  const path = event.path?.trim();
  if (!path) {
    return undefined;
  }
  return normalizeResource(path);
}

function templateToRegex(resource: string): RegExp {
  const pattern = resource
    .split('/')
    .map((segment) => {
      if (!segment) {
        return '';
      }
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return '[^/]+';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`);
}

const ROUTES_BY_METHOD = new Map<string, HttpRouteDef[]>();
for (const route of HTTP_ROUTE_DEFS) {
  const list = ROUTES_BY_METHOD.get(route.method) ?? [];
  list.push(route);
  ROUTES_BY_METHOD.set(route.method, list);
}
for (const list of ROUTES_BY_METHOD.values()) {
  list.sort((a, b) => b.resource.length - a.resource.length);
}

const TEMPLATE_REGEX = new Map<string, RegExp>(
  HTTP_ROUTE_DEFS.map((route) => [route.resource, templateToRegex(route.resource)]),
);

/**
 * Resolve the route definition for an API Gateway event.
 * Prefers `resource` (path template). Falls back to matching the request path.
 */
export function matchHttpRoute(
  event: APIGatewayProxyEvent,
): HttpRouteDef | undefined {
  const method = eventMethod(event);
  const candidates = ROUTES_BY_METHOD.get(method);
  if (!candidates?.length) {
    return undefined;
  }

  const resource = eventResourceTemplate(event);
  if (resource) {
    const exact = candidates.find((route) => route.resource === resource);
    if (exact) {
      return exact;
    }
  }

  const requestPath = eventRequestPath(event) ?? resource;
  if (!requestPath) {
    return undefined;
  }

  return candidates.find((route) => {
    const regex = TEMPLATE_REGEX.get(route.resource);
    return regex ? regex.test(requestPath) : false;
  });
}

export function notFoundResponse(): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: 'No handler for this route',
      },
    }),
  };
}

export async function dispatchHttpEvent(
  event: APIGatewayProxyEvent,
  context: Context,
  resolveHandler: (
    route: HttpRouteDef,
  ) =>
    | ((
        event: APIGatewayProxyEvent,
        context: Context,
      ) => Promise<APIGatewayProxyResult | undefined>)
    | undefined,
): Promise<APIGatewayProxyResult> {
  const route = matchHttpRoute(event);
  if (!route) {
    return notFoundResponse();
  }
  const handler = resolveHandler(route);
  if (!handler) {
    return notFoundResponse();
  }
  const result = await handler(event, context);
  if (result === undefined) {
    return notFoundResponse();
  }
  return result;
}
