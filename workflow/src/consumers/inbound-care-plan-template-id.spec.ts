import { resolveInboundCarePlanTemplateId } from './inbound-care-plan-template-id';
import { TemporaryCarePlanTemplateIdResolutionError } from './temporary-care-plan-template-id.resolver';

describe('resolveInboundCarePlanTemplateId', () => {
  it('uses event carePlanTemplateId and does not call CPR', async () => {
    const getTemplateSnapshot = jest.fn();
    const result = await resolveInboundCarePlanTemplateId(
      {
        carePlanId: 'cpi-1',
        carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
      },
      { carePlanRuntimeClient: { getTemplateSnapshot } as never },
    );
    expect(result).toEqual({
      carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
      usedSnapshotFallback: false,
    });
    expect(getTemplateSnapshot).not.toHaveBeenCalled();
  });

  it('rejects templateVersionId (…-Vnn) and does not parse it to catalog id', async () => {
    const getTemplateSnapshot = jest.fn();
    await expect(
      resolveInboundCarePlanTemplateId(
        {
          carePlanId: 'cpi-1',
          carePlanTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD-V01',
        },
        { carePlanRuntimeClient: { getTemplateSnapshot } as never },
      ),
    ).rejects.toMatchObject({
      code: 'CARE_PLAN_TEMPLATE_ID_IS_VERSION',
    });
    expect(getTemplateSnapshot).not.toHaveBeenCalled();
  });

  it('rejects carePlanInstanceId used as carePlanTemplateId', async () => {
    await expect(
      resolveInboundCarePlanTemplateId({
        carePlanId: 'cpi-1',
        carePlanTemplateId: 'cpi-1',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('falls back to CPR snapshot when the event omits carePlanTemplateId', async () => {
    const getTemplateSnapshot = jest.fn().mockResolvedValue({
      orgTemplateId: 'HTN-CARE-PLAN-ORG-ROSEWOOD',
      linkedOrgCarePlanVersionId: 'HTN-CARE-PLAN-ORG-ROSEWOOD-V01',
    });
    const result = await resolveInboundCarePlanTemplateId(
      { carePlanId: 'cpi-1' },
      { carePlanRuntimeClient: { getTemplateSnapshot } as never },
    );
    expect(result.usedSnapshotFallback).toBe(true);
    expect(result.carePlanTemplateId).toBe('HTN-CARE-PLAN-ORG-ROSEWOOD');
    expect(getTemplateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not swallow TemporaryCarePlanTemplateIdResolutionError from snapshot', async () => {
    await expect(
      resolveInboundCarePlanTemplateId(
        { carePlanId: 'cpi-1' },
        {
          carePlanRuntimeClient: {
            getTemplateSnapshot: jest.fn().mockResolvedValue({}),
          } as never,
        },
      ),
    ).rejects.toBeInstanceOf(TemporaryCarePlanTemplateIdResolutionError);
  });
});
