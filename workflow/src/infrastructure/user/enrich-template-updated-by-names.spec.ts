import {
  enrichTemplateHttpDtoWithActorNames,
  enrichTemplateSummariesWithUpdatedByNames,
} from './enrich-template-updated-by-names';
import type {
  WorkflowTemplateHttpDto,
  WorkflowTemplateSummaryHttpDto,
} from '../../mappers/workflow-template-http.mapper';

describe('enrichTemplateSummariesWithUpdatedByNames', () => {
  function summary(
    overrides: Partial<WorkflowTemplateSummaryHttpDto> = {},
  ): WorkflowTemplateSummaryHttpDto {
    return {
      scope: 'platform',
      templateId: 'tmpl-1',
      templateName: 'T',
      workflowType: 'PATIENT_ONBOARDING',
      workflowStage: 'PATIENT_ONBOARDING',
      status: 'published',
      version: 2,
      stepCount: 1,
      checklistItemCount: 0,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T10:00:00.000Z',
      recordVersion: 2,
      ...overrides,
    };
  }

  it('resolves updatedBy to updatedByName and keeps updatedBy', async () => {
    const getProfilesByIds = jest.fn().mockResolvedValue(
      new Map([['user-1', { displayName: 'Sumit Kumar', email: 's@x.com' }]]),
    );

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      [summary({ updatedBy: 'user-1' })],
      { profiles: { getProfilesByIds } as never },
    );

    expect(items[0].updatedBy).toBe('user-1');
    expect(items[0].updatedByName).toBe('Sumit Kumar');
    expect(getProfilesByIds).toHaveBeenCalledWith(['user-1']);
  });

  it('resolves createdBy to createdByName and keeps createdBy', async () => {
    const creatorId =
      '88a9a6e052092188660a404a303ca34c992caabfccfc184ca2121fcac2d84e7f';
    const getProfilesByIds = jest.fn().mockResolvedValue(
      new Map([[creatorId, { displayName: 'Root Admin' }]]),
    );

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      [summary({ createdBy: creatorId })],
      { profiles: { getProfilesByIds } as never },
    );

    expect(items[0].createdBy).toBe(creatorId);
    expect(items[0].createdByName).toBe('Root Admin');
    expect(getProfilesByIds).toHaveBeenCalledWith([creatorId]);
  });

  it('resolves createdBy and updatedBy in one BatchGet when both present', async () => {
    const getProfilesByIds = jest.fn().mockResolvedValue(
      new Map([
        ['creator-1', { displayName: 'Creator Name' }],
        ['updater-1', { displayName: 'Updater Name' }],
      ]),
    );

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      [summary({ createdBy: 'creator-1', updatedBy: 'updater-1' })],
      { profiles: { getProfilesByIds } as never },
    );

    expect(getProfilesByIds).toHaveBeenCalledTimes(1);
    expect(getProfilesByIds).toHaveBeenCalledWith(
      expect.arrayContaining(['creator-1', 'updater-1']),
    );
    expect(items[0].createdBy).toBe('creator-1');
    expect(items[0].createdByName).toBe('Creator Name');
    expect(items[0].updatedBy).toBe('updater-1');
    expect(items[0].updatedByName).toBe('Updater Name');
  });

  it('deduplicates updatedBy ids before lookup (no N+1)', async () => {
    const getProfilesByIds = jest.fn().mockResolvedValue(
      new Map([['user-1', { displayName: 'Sumit Kumar' }]]),
    );

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      [
        summary({ templateId: 'a', updatedBy: 'user-1' }),
        summary({ templateId: 'b', updatedBy: 'user-1' }),
        summary({ templateId: 'c', updatedBy: 'user-1' }),
      ],
      { profiles: { getProfilesByIds } as never },
    );

    expect(getProfilesByIds).toHaveBeenCalledTimes(1);
    expect(getProfilesByIds).toHaveBeenCalledWith(['user-1']);
    expect(items.every((i) => i.updatedByName === 'Sumit Kumar')).toBe(true);
  });

  it('omits updatedByName when user cannot be resolved and does not throw', async () => {
    const getProfilesByIds = jest.fn().mockResolvedValue(new Map());

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      [summary({ updatedBy: 'missing-user' })],
      { profiles: { getProfilesByIds } as never },
    );

    expect(items[0].updatedBy).toBe('missing-user');
    expect(items[0].updatedByName).toBeUndefined();
  });

  it('returns original items when profile lookup throws', async () => {
    const getProfilesByIds = jest.fn().mockRejectedValue(new Error('ddb down'));

    const input = [summary({ updatedBy: 'user-1' })];
    const items = await enrichTemplateSummariesWithUpdatedByNames(input, {
      profiles: { getProfilesByIds } as never,
    });

    expect(items).toEqual(input);
    expect(items[0].updatedByName).toBeUndefined();
  });
});

describe('enrichTemplateHttpDtoWithActorNames', () => {
  it('reuses list enrichment for GET and preserves steps', async () => {
    const getProfilesByIds = jest.fn().mockResolvedValue(
      new Map([['user-1', { displayName: 'Sumit Kumar' }]]),
    );

    const dto: WorkflowTemplateHttpDto = {
      scope: 'platform',
      templateId: 'tmpl-1',
      templateName: 'T',
      workflowType: 'PATIENT_ONBOARDING',
      workflowStage: 'PATIENT_ONBOARDING',
      status: 'published',
      version: 2,
      stepCount: 1,
      checklistItemCount: 0,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T10:00:00.000Z',
      createdBy: 'user-1',
      updatedBy: 'user-1',
      recordVersion: 2,
      steps: [
        {
          stepId: 'step-1',
          name: 'Step',
          requirement: 'mandatory',
          allowSkip: false,
          allowDefer: false,
          condition: null,
          sortOrder: 1,
          checklists: [],
        },
      ],
    };

    const enriched = await enrichTemplateHttpDtoWithActorNames(dto, {
      profiles: { getProfilesByIds } as never,
    });

    expect(enriched.createdBy).toBe('user-1');
    expect(enriched.createdByName).toBe('Sumit Kumar');
    expect(enriched.updatedBy).toBe('user-1');
    expect(enriched.updatedByName).toBe('Sumit Kumar');
    expect(enriched.steps).toEqual(dto.steps);
    expect(getProfilesByIds).toHaveBeenCalledTimes(1);
  });
});
