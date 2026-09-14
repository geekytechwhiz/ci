/**
 * TEMPORARY (DEV testing): Care Plan Runtime HTTP client for template-snapshot.
 *
 * Used when CarePlanWorkflowRequested omits carePlanTemplateId.
 * Remove when CPR always publishes carePlanTemplateId.
 *
 * GET /care-plan-instances/template-snapshot?carePlanInstanceId=&includeLinkedTemplates=
 * Auth: Authorization: Bearer ${INTERNAL_SERVICE_TOKEN}
 */

import { buildInternalServiceAuthHeader } from './internal-service-auth';

export type CarePlanTemplateSnapshotData = {
  carePlanInstanceId: string;
  orgId: string;
  patientId: string;
  linkedOrgCarePlanVersionId?: string;
  hasTemplateSnapshot?: boolean;
  orgTemplateId?: string | null;
  orgCarePlan?: {
    orgTemplateId?: string;
    [key: string]: unknown;
  } | null;
  manifest?: {
    orgTemplateId?: string;
    [key: string]: unknown;
  } | null;
};

type ApiEnvelope<T> = {
  success?: boolean;
  statusCode?: number;
  data?: T;
  error?: unknown;
};

export interface CarePlanRuntimeClientDeps {
  baseUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CarePlanRuntimeHttpError extends Error {
  readonly statusCode: number;
  readonly url: string;
  readonly retryable: boolean;

  constructor(statusCode: number, url: string, bodySnippet: string) {
    super(`Care Plan Runtime HTTP ${statusCode} for ${url}: ${bodySnippet}`);
    this.name = 'CarePlanRuntimeHttpError';
    this.statusCode = statusCode;
    this.url = url;
    this.retryable = statusCode >= 500 || statusCode === 429;
  }
}

function assertBaseUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '');
  if (!u) {
    throw new Error('CARE_PLAN_RUNTIME_BASE_URL is not configured');
  }
  return u;
}

async function parseJsonBody<T>(res: Response, url: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CarePlanRuntimeHttpError(res.status, url, text.slice(0, 300));
  }

  const body = (await res.json()) as ApiEnvelope<T> | T;
  if (body && typeof body === 'object' && 'data' in body) {
    const env = body as ApiEnvelope<T>;
    if (env.data == null) {
      throw new Error(`Care Plan Runtime empty data for ${url}`);
    }
    return env.data;
  }
  return body as T;
}

export class CarePlanRuntimeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: CarePlanRuntimeClientDeps) {
    this.baseUrl = assertBaseUrl(deps.baseUrl);
    const header = deps.authHeader?.trim();
    if (!header) {
      throw new Error(
        'CarePlanRuntimeClient requires authHeader (INTERNAL_SERVICE_TOKEN)',
      );
    }
    this.authHeader = header;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  async getTemplateSnapshot(input: {
    carePlanInstanceId: string;
    includeLinkedTemplates?: boolean;
  }): Promise<CarePlanTemplateSnapshotData> {
    const id = encodeURIComponent(input.carePlanInstanceId.trim());
    const include =
      input.includeLinkedTemplates === false ? 'false' : 'true';
    const url = `${this.baseUrl}/care-plan-instances/template-snapshot?carePlanInstanceId=${id}&includeLinkedTemplates=${include}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.authHeader,
        },
        signal: controller.signal,
      });
      return parseJsonBody<CarePlanTemplateSnapshotData>(res, url);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createCarePlanRuntimeClientFromEnv(
  overrides: Partial<CarePlanRuntimeClientDeps> = {},
): CarePlanRuntimeClient {
  return new CarePlanRuntimeClient({
    baseUrl:
      overrides.baseUrl ?? process.env.CARE_PLAN_RUNTIME_BASE_URL ?? '',
    authHeader: overrides.authHeader ?? buildInternalServiceAuthHeader(),
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  });
}
