import {
  parseOrgTemplateIdFromVersionId,
  resolveCarePlanTemplateIdFromSnapshot,
  resolveCarePlanTemplateIdViaSnapshot,
  TemporaryCarePlanTemplateIdResolutionError,
} from './temporary-care-plan-template-id.resolver';
import type { CarePlanRuntimeClient } from '../infrastructure/http/care-plan-runtime.client';

describe('temporary carePlanTemplateId resolver', () => {
  it('parses version id to catalog id', () => {
    expect(parseOrgTemplateIdFromVersionId('HTN-CARE-PLAN-V01')).toBe(
      'HTN-CARE-PLAN',
    );
  });

  it('prefers snapshot.orgTemplateId', () => {
    expect(
      resolveCarePlanTemplateIdFromSnapshot({
        orgTemplateId: 'HTN-CARE-PLAN',
        linkedOrgCarePlanVersionId: 'HTN-CARE-PLAN-V01',
      }),
    ).toBe('HTN-CARE-PLAN');
  });

  it('falls back to parse linkedOrgCarePlanVersionId', () => {
    expect(
      resolveCarePlanTemplateIdFromSnapshot({
        orgTemplateId: null,
        linkedOrgCarePlanVersionId: 'FIRMINIQ-GLUCOSE-CARE-PLAN-9a1fe214-V01',
      }),
    ).toBe('FIRMINIQ-GLUCOSE-CARE-PLAN-9a1fe214');
  });

  it('throws when unresolved', () => {
    expect(() => resolveCarePlanTemplateIdFromSnapshot({})).toThrow(
      TemporaryCarePlanTemplateIdResolutionError,
    );
  });

  it('calls CPR client and returns catalog id', async () => {
    const client = {
      getTemplateSnapshot: jest.fn().mockResolvedValue({
        carePlanInstanceId: 'cpi-1',
        orgId: 'org-1',
        patientId: 'pat-1',
        orgTemplateId: 'ORG-TEMPLATE-A',
        linkedOrgCarePlanVersionId: 'ORG-TEMPLATE-A-V01',
      }),
    } as unknown as CarePlanRuntimeClient;

    await expect(
      resolveCarePlanTemplateIdViaSnapshot('cpi-1', { client }),
    ).resolves.toBe('ORG-TEMPLATE-A');

    expect(client.getTemplateSnapshot).toHaveBeenCalledWith({
      carePlanInstanceId: 'cpi-1',
      includeLinkedTemplates: true,
    });
  });
});
