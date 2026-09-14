

import type { CarePlanRuntimeClient } from '../infrastructure/http/care-plan-runtime.client';
import { CarePlanWorkflowRequestedParseError } from '../mappers/care-plan-workflow-requested.mapper';
import type { CarePlanWorkflowRequestedPayload } from '../validators/care-plan-workflow-requested.schemas';
import {
  resolveCarePlanTemplateIdViaSnapshot,
  TemporaryCarePlanTemplateIdResolutionError,
} from './temporary-care-plan-template-id.resolver';

const VERSION_ID = /-V\d+$/i;



export async function resolveInboundCarePlanTemplateId(
  payload: Pick<
    CarePlanWorkflowRequestedPayload,
    'carePlanId' | 'carePlanTemplateId'
  >,
  deps: { carePlanRuntimeClient?: CarePlanRuntimeClient } = {},
): Promise<{ carePlanTemplateId: string; usedSnapshotFallback: boolean }> {
  const fromEvent = payload.carePlanTemplateId?.trim();
  if (fromEvent) {
    assertInboundCarePlanTemplateIdIsCatalog(fromEvent, payload.carePlanId);
    return { carePlanTemplateId: fromEvent, usedSnapshotFallback: false };
  }

  const fromSnapshot = await resolveCarePlanTemplateIdViaSnapshot(
    payload.carePlanId,
    { client: deps.carePlanRuntimeClient },
  );
  return { carePlanTemplateId: fromSnapshot, usedSnapshotFallback: true };
}

export function assertInboundCarePlanTemplateIdIsCatalog(
  carePlanTemplateId: string,
  carePlanId?: string,
): void {
  const id = carePlanTemplateId.trim();
  if (VERSION_ID.test(id)) {
    throw new TemporaryCarePlanTemplateIdResolutionError(
      'carePlanTemplateId must be Org Care Plan catalog id (orgTemplateId), not templateVersionId',
      'CARE_PLAN_TEMPLATE_ID_IS_VERSION',
    );
  }
  if (carePlanId?.trim() && id === carePlanId.trim()) {
    throw new CarePlanWorkflowRequestedParseError(
      'carePlanTemplateId must not equal carePlanId (instance id)',
    );
  }
}
