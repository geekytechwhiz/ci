/**
 * Resolve actor user IDs to display names for Workflow Template list and GET APIs.
 *
 * Reuses the template-service USER_TABLE BatchGet pattern (same table / key shapes
 * as Care Plan Templates list enrichment). Monitoring Runtime resolves names at
 * write time via org-scoped HTTP; platform template list/GET need read-path
 * enrichment without organizationId — USER_TABLE batch lookup is the established
 * approach.
 *
 * - Keeps `createdBy` / `updatedBy` unchanged (raw ids).
 * - Adds `createdByName` / `updatedByName` when a person name (or email fallback)
 *   is found.
 * - Deduplicates IDs and uses BatchGet — no N+1.
 * - Lookup failures never fail the list or GET API.
 */

import type {
  WorkflowTemplateHttpDto,
  WorkflowTemplateSummaryHttpDto,
} from '../../mappers/workflow-template-http.mapper';
import {
  getUserProfileRepository,
  type UserProfileRepository,
} from './user-profile.repository';

export type EnrichUpdatedByNamesDeps = {
  profiles?: UserProfileRepository;
};

function collectUniqueActorIds(
  items: ReadonlyArray<WorkflowTemplateSummaryHttpDto>,
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    const created = item.createdBy?.trim();
    const updated = item.updatedBy?.trim();
    if (created) ids.add(created);
    if (updated) ids.add(updated);
  }
  return [...ids];
}

function withDisplayName(
  item: WorkflowTemplateSummaryHttpDto,
  field: 'createdBy' | 'updatedBy',
  nameField: 'createdByName' | 'updatedByName',
  profiles: Map<string, { displayName?: string }>,
): WorkflowTemplateSummaryHttpDto {
  const id = item[field]?.trim();
  if (!id) return item;
  const displayName = profiles.get(id)?.displayName?.trim();
  if (!displayName) return item;
  return { ...item, [nameField]: displayName };
}

/**
 * Attach display names on each summary that has a resolvable `createdBy` /
 * `updatedBy`. Unresolved users omit the `*Name` field so clients can fall
 * back to the raw id.
 */
export async function enrichTemplateSummariesWithUpdatedByNames(
  items: WorkflowTemplateSummaryHttpDto[],
  deps?: EnrichUpdatedByNamesDeps,
): Promise<WorkflowTemplateSummaryHttpDto[]> {
  if (items.length === 0) return items;

  const uniqueIds = collectUniqueActorIds(items);
  if (uniqueIds.length === 0) return items;

  let profiles: Map<string, { displayName?: string }>;
  try {
    const repo = deps?.profiles ?? getUserProfileRepository();
    profiles = await repo.getProfilesByIds(uniqueIds);
  } catch {
    return items;
  }

  return items.map((item) => {
    const withCreated = withDisplayName(
      item,
      'createdBy',
      'createdByName',
      profiles,
    );
    return withDisplayName(
      withCreated,
      'updatedBy',
      'updatedByName',
      profiles,
    );
  });
}

/** Same USER_TABLE enrichment as list, applied to a full GET DTO (steps preserved). */
export async function enrichTemplateHttpDtoWithActorNames(
  dto: WorkflowTemplateHttpDto,
  deps?: EnrichUpdatedByNamesDeps,
): Promise<WorkflowTemplateHttpDto> {
  const { steps, ...summary } = dto;
  const [enriched] = await enrichTemplateSummariesWithUpdatedByNames(
    [summary],
    deps,
  );
  return { ...enriched, steps };
}
