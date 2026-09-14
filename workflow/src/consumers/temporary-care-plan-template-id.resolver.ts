/**
 * TEMPORARY (legacy events only): resolve carePlanTemplateId from CPR
 * template-snapshot when CarePlanWorkflowRequested omits it.
 *
 * New events carry carePlanTemplateId (org catalog id) and skip this path.
 * Keep this module until in-flight / old events without the field are gone.
 */

import type { CarePlanRuntimeClient } from '../infrastructure/http/care-plan-runtime.client';
import { createCarePlanRuntimeClientFromEnv } from '../infrastructure/http/care-plan-runtime.client';

export class TemporaryCarePlanTemplateIdResolutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    code = 'CARE_PLAN_TEMPLATE_ID_UNAVAILABLE',
    retryable = false,
  ) {
    super(message);
    this.name = 'TemporaryCarePlanTemplateIdResolutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function parseOrgTemplateIdFromVersionId(
  versionId: string,
): string | undefined {
  const trimmed = versionId.trim();
  const match = trimmed.match(/^(.*)-V\d+$/i);
  if (!match?.[1]?.trim()) return undefined;
  return match[1].trim();
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

export function resolveCarePlanTemplateIdFromSnapshot(input: {
  orgTemplateId?: string | null;
  orgCarePlanOrgTemplateId?: string | null;
  linkedOrgCarePlanVersionId?: string | null;
}): string {
  const versionId = nonEmpty(input.linkedOrgCarePlanVersionId);

  const fromSnapshot = nonEmpty(input.orgTemplateId);
  if (fromSnapshot) {
    if (versionId && fromSnapshot === versionId) {
      throw new TemporaryCarePlanTemplateIdResolutionError(
        'carePlanTemplateId must not equal linkedOrgCarePlanVersionId',
        'CARE_PLAN_TEMPLATE_ID_IS_VERSION',
      );
    }
    return fromSnapshot;
  }

  const fromOrgCarePlan = nonEmpty(input.orgCarePlanOrgTemplateId);
  if (fromOrgCarePlan) {
    if (versionId && fromOrgCarePlan === versionId) {
      throw new TemporaryCarePlanTemplateIdResolutionError(
        'carePlanTemplateId must not equal linkedOrgCarePlanVersionId',
        'CARE_PLAN_TEMPLATE_ID_IS_VERSION',
      );
    }
    return fromOrgCarePlan;
  }

  if (!versionId) {
    throw new TemporaryCarePlanTemplateIdResolutionError(
      'Cannot resolve carePlanTemplateId from CPR snapshot',
      'CARE_PLAN_TEMPLATE_ID_UNAVAILABLE',
    );
  }

  const parsed = parseOrgTemplateIdFromVersionId(versionId);
  if (!parsed || parsed === versionId) {
    throw new TemporaryCarePlanTemplateIdResolutionError(
      `Cannot parse catalog id from linkedOrgCarePlanVersionId=${versionId}`,
      'MALFORMED_LINKED_ORG_CARE_PLAN_VERSION_ID',
    );
  }
  return parsed;
}

export type TemporaryCarePlanTemplateIdResolverDeps = {
  client?: CarePlanRuntimeClient;
};

/**
 * GET CPR template-snapshot for carePlanId → catalog orgTemplateId.
 */
export async function resolveCarePlanTemplateIdViaSnapshot(
  carePlanId: string,
  deps: TemporaryCarePlanTemplateIdResolverDeps = {},
): Promise<string> {
  const client = deps.client ?? createCarePlanRuntimeClientFromEnv();
  const snapshot = await client.getTemplateSnapshot({
    carePlanInstanceId: carePlanId,
    includeLinkedTemplates: true,
  });

  return resolveCarePlanTemplateIdFromSnapshot({
    orgTemplateId: snapshot.orgTemplateId,
    orgCarePlanOrgTemplateId:
      typeof snapshot.orgCarePlan?.orgTemplateId === 'string'
        ? snapshot.orgCarePlan.orgTemplateId
        : undefined,
    linkedOrgCarePlanVersionId: snapshot.linkedOrgCarePlanVersionId,
  });
}
