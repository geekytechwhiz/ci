import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  type BatchGetCommandInput,
  type BatchGetCommandOutput,
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '@api-hub/utils';

function userTableName(): string | undefined {
  const name = process.env.USER_TABLE?.trim();
  return name || undefined;
}

const USER_PK_PREFIX = 'USER#';
const ORG_PK_ROOT = 'ORG#ROOT';
const ORG_SK_ROOT = 'ORG#ROOT';
const ORG_SK_PREFIX = 'ORG#';
const USER_BASIC_DETAILS_SK = 'USER_BASIC_DETAILS#ROOT';
const BATCH_GET_MAX_KEYS = 100;

type UserTableKey = Record<string, string>;

export type UserProfileFields = { email?: string; displayName?: string };

/**
 * DynamoDB Document Client returns untyped attribute maps (`Record<string, unknown>`).
 * Compile-time TypeScript types do not exist at runtime and do not guarantee a field is a string
 * (it may be missing, null, number, etc.). Narrow once here.
 */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function docSend<T>(command: unknown): Promise<T> {
  return (await (ddbDocClient as { send: (cmd: unknown) => Promise<unknown> }).send(command)) as T;
}

function isValidationException(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? '';
  return name === 'ValidationException' || message.includes('ValidationException');
}

/** User→org membership item: pk=USER#id, sk=ORG#ROOT */
function userRootKey(userId: string, uppercaseKeys: boolean): UserTableKey {
  return uppercaseKeys
    ? { PK: `${USER_PK_PREFIX}${userId}`, SK: ORG_SK_ROOT }
    : { pk: `${USER_PK_PREFIX}${userId}`, sk: ORG_SK_ROOT };
}

/** User profile details item: pk=USER#id, sk=USER_BASIC_DETAILS#ROOT */
function userBasicDetailsKey(userId: string, uppercaseKeys: boolean): UserTableKey {
  return uppercaseKeys
    ? { PK: `${USER_PK_PREFIX}${userId}`, SK: USER_BASIC_DETAILS_SK }
    : { pk: `${USER_PK_PREFIX}${userId}`, sk: USER_BASIC_DETAILS_SK };
}

/** Org→user item (common for ROOT admins): pk=ORG#ROOT, sk=USER#id */
function orgRootUserKey(userId: string, uppercaseKeys: boolean): UserTableKey {
  return uppercaseKeys
    ? { PK: ORG_PK_ROOT, SK: `${USER_PK_PREFIX}${userId}` }
    : { pk: ORG_PK_ROOT, sk: `${USER_PK_PREFIX}${userId}` };
}

/** True when row has a real person name (not email-only). */
export function rowHasPersonName(item: Record<string, unknown>): boolean {
  if (nonEmptyString(item.fullName)) return true;
  return Boolean(
    [nonEmptyString(item.firstName), nonEmptyString(item.lastName)].filter(Boolean).join(' '),
  );
}

export function resolveUserDisplayName(item: Record<string, unknown>): string | undefined {
  const fullName = nonEmptyString(item.fullName);
  if (fullName) return fullName;

  const fromParts = [nonEmptyString(item.firstName), nonEmptyString(item.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fromParts) return fromParts;

  return nonEmptyString(item.emailAddress);
}

export function resolveUserEmail(item: Record<string, unknown>): string | undefined {
  return nonEmptyString(item.emailAddress);
}

function profileFromRow(row: Record<string, unknown>): UserProfileFields {
  return {
    email: resolveUserEmail(row),
    displayName: resolveUserDisplayName(row),
  };
}

/** Sparse membership / email-only rows must not block richer profile lookups. */
function isNameIncomplete(profile: UserProfileFields | undefined): boolean {
  if (!profile?.displayName?.trim()) return true;
  if (profile.email && profile.displayName.trim() === profile.email.trim()) return true;
  return false;
}

function mergeProfiles(
  prev: UserProfileFields | undefined,
  next: UserProfileFields,
): UserProfileFields {
  if (!prev) return next;
  const nextComplete = !isNameIncomplete(next);
  const prevComplete = !isNameIncomplete(prev);
  if (nextComplete && !prevComplete) {
    return { email: next.email ?? prev.email, displayName: next.displayName };
  }
  if (prevComplete && !nextComplete) {
    return { email: prev.email ?? next.email, displayName: prev.displayName };
  }
  return {
    email: next.email ?? prev.email,
    displayName: next.displayName ?? prev.displayName,
  };
}

function pickBestRow(
  rows: Array<Record<string, unknown> | null | undefined>,
): Record<string, unknown> | null {
  const present = rows.filter((r): r is Record<string, unknown> => r != null);
  const named = present.find((r) => rowHasPersonName(r));
  if (named) return named;
  const withEmail = present.find((r) => resolveUserEmail(r));
  return withEmail ?? present[0] ?? null;
}

function userIdFromRow(row: Record<string, unknown>): string | null {
  const pk = (row.pk ?? row.PK) as unknown;
  if (typeof pk === 'string' && pk.startsWith(USER_PK_PREFIX)) {
    return pk.slice(USER_PK_PREFIX.length);
  }

  const sk = (row.sk ?? row.SK) as unknown;
  if (typeof sk === 'string' && sk.startsWith(USER_PK_PREFIX)) {
    return sk.slice(USER_PK_PREFIX.length);
  }

  const attr = row.userID ?? row.userId;
  if (typeof attr === 'string' && attr.trim()) return attr.trim();
  return null;
}

async function getByKey(
  tableName: string,
  key: UserTableKey,
): Promise<Record<string, unknown> | null> {
  const out = await docSend<GetCommandOutput>(
    new GetCommand({
      TableName: tableName,
      Key: key,
    }),
  );
  return out.Item != null ? (out.Item as Record<string, unknown>) : null;
}

async function getOrgRootRow(
  tableName: string,
  userId: string,
  uppercaseKeys: boolean,
): Promise<Record<string, unknown> | null> {
  return getByKey(tableName, userRootKey(userId, uppercaseKeys));
}

async function getUserBasicDetailsRow(
  tableName: string,
  userId: string,
  uppercaseKeys: boolean,
): Promise<Record<string, unknown> | null> {
  return getByKey(tableName, userBasicDetailsKey(userId, uppercaseKeys));
}

/** Fallback when only the org-partitioned item exists (pk=ORG#ROOT, sk=USER#id). */
async function getOrgPartitionUserRow(
  tableName: string,
  userId: string,
  uppercaseKeys: boolean,
): Promise<Record<string, unknown> | null> {
  return getByKey(tableName, orgRootUserKey(userId, uppercaseKeys));
}

async function queryFirstOrgRow(
  tableName: string,
  userId: string,
  uppercaseKeys: boolean,
): Promise<Record<string, unknown> | null> {
  const pkAttr = uppercaseKeys ? 'PK' : 'pk';
  const skAttr = uppercaseKeys ? 'SK' : 'sk';
  const out = await docSend<QueryCommandOutput>(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: `${pkAttr} = :pk AND begins_with(#sk, :skp)`,
      ExpressionAttributeNames: { '#sk': skAttr },
      ExpressionAttributeValues: {
        ':pk': `${USER_PK_PREFIX}${userId}`,
        ':skp': ORG_SK_PREFIX,
      },
      Limit: 1,
    }),
  );
  const row = out.Items?.[0];
  return row != null ? (row as Record<string, unknown>) : null;
}

/**
 * Prefer rows with a person name. STG often has a sparse USER#/ORG#ROOT membership
 * while fullName lives on ORG#ROOT/USER# (or USER_BASIC_DETAILS#ROOT).
 */
async function loadUserProfileRowWithCase(
  tableName: string,
  userId: string,
  uppercaseKeys: boolean,
): Promise<Record<string, unknown> | null> {
  const root = await getOrgRootRow(tableName, userId, uppercaseKeys);
  if (root && rowHasPersonName(root)) return root;

  const basic = await getUserBasicDetailsRow(tableName, userId, uppercaseKeys);
  if (basic && rowHasPersonName(basic)) return basic;

  const orgMembership = await queryFirstOrgRow(tableName, userId, uppercaseKeys);
  if (orgMembership && rowHasPersonName(orgMembership)) return orgMembership;

  const orgPartition = await getOrgPartitionUserRow(tableName, userId, uppercaseKeys);
  if (orgPartition && rowHasPersonName(orgPartition)) return orgPartition;

  return pickBestRow([root, basic, orgMembership, orgPartition]);
}

async function loadUserProfileRow(
  tableName: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await loadUserProfileRowWithCase(tableName, userId, false);
  } catch (err) {
    if (!isValidationException(err)) return null;
    try {
      return await loadUserProfileRowWithCase(tableName, userId, true);
    } catch {
      return null;
    }
  }
}

async function batchGetByKeys(
  tableName: string,
  keys: UserTableKey[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  if (keys.length === 0) return rows;

  for (let i = 0; i < keys.length; i += BATCH_GET_MAX_KEYS) {
    const slice = keys.slice(i, i + BATCH_GET_MAX_KEYS);
    let requestItems: NonNullable<BatchGetCommandInput['RequestItems']> = {
      [tableName]: { Keys: slice },
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await docSend<BatchGetCommandOutput>(
        new BatchGetCommand({ RequestItems: requestItems }),
      );
      for (const raw of out.Responses?.[tableName] ?? []) {
        rows.push(raw as Record<string, unknown>);
      }

      const unprocessed = out.UnprocessedKeys;
      if (!unprocessed || Object.keys(unprocessed).length === 0) break;
      requestItems = unprocessed as typeof requestItems;
    }
  }

  return rows;
}

function mergeRowsIntoProfileMap(
  map: Map<string, UserProfileFields>,
  rows: Record<string, unknown>[],
): void {
  for (const row of rows) {
    const id = userIdFromRow(row);
    if (!id) continue;
    map.set(id, mergeProfiles(map.get(id), profileFromRow(row)));
  }
}

async function batchGetOrgRootRows(
  tableName: string,
  userIds: string[],
  uppercaseKeys: boolean,
): Promise<Map<string, UserProfileFields>> {
  const map = new Map<string, UserProfileFields>();
  const rows = await batchGetByKeys(
    tableName,
    userIds.map((userId) => userRootKey(userId, uppercaseKeys)),
  );
  mergeRowsIntoProfileMap(map, rows);
  return map;
}

async function batchGetUserBasicDetailsRows(
  tableName: string,
  userIds: string[],
  uppercaseKeys: boolean,
): Promise<Map<string, UserProfileFields>> {
  const map = new Map<string, UserProfileFields>();
  const rows = await batchGetByKeys(
    tableName,
    userIds.map((userId) => userBasicDetailsKey(userId, uppercaseKeys)),
  );
  mergeRowsIntoProfileMap(map, rows);
  return map;
}

async function batchGetOrgPartitionUserRows(
  tableName: string,
  userIds: string[],
  uppercaseKeys: boolean,
): Promise<Map<string, UserProfileFields>> {
  const map = new Map<string, UserProfileFields>();
  const rows = await batchGetByKeys(
    tableName,
    userIds.map((userId) => orgRootUserKey(userId, uppercaseKeys)),
  );
  mergeRowsIntoProfileMap(map, rows);
  return map;
}

function idsNeedingRicherProfile(
  unique: string[],
  map: Map<string, UserProfileFields>,
): string[] {
  return unique.filter((id) => isNameIncomplete(map.get(id)));
}

async function loadProfilesForIds(
  tableName: string,
  unique: string[],
  uppercaseKeys = false,
): Promise<Map<string, UserProfileFields>> {
  const map = new Map<string, UserProfileFields>();

  const fromBatch = await batchGetOrgRootRows(tableName, unique, uppercaseKeys);
  for (const [k, v] of fromBatch) map.set(k, mergeProfiles(map.get(k), v));

  let pending = idsNeedingRicherProfile(unique, map);
  if (pending.length > 0) {
    const fromBasic = await batchGetUserBasicDetailsRows(tableName, pending, uppercaseKeys);
    for (const [k, v] of fromBasic) map.set(k, mergeProfiles(map.get(k), v));
  }

  pending = idsNeedingRicherProfile(unique, map);
  for (const id of pending) {
    const row = await queryFirstOrgRow(tableName, id, uppercaseKeys);
    if (!row) continue;
    const resolvedId = userIdFromRow(row) ?? id;
    map.set(resolvedId, mergeProfiles(map.get(resolvedId), profileFromRow(row)));
  }

  pending = idsNeedingRicherProfile(unique, map);
  if (pending.length > 0) {
    const fromOrgPartition = await batchGetOrgPartitionUserRows(tableName, pending, uppercaseKeys);
    for (const [k, v] of fromOrgPartition) map.set(k, mergeProfiles(map.get(k), v));
  }

  return map;
}

/**
 * USER_TABLE profile repository.
 * Lookup order: USER#/ORG#ROOT → USER#/USER_BASIC_DETAILS#ROOT → USER#/ORG#* → ORG#ROOT/USER#.
 * Sparse membership rows (no person name) do not stop later lookups.
 */
export class UserProfileRepository {
  async getByUserId(userId: string): Promise<Record<string, unknown> | null> {
    const id = userId?.trim();
    const tableName = userTableName();
    if (!id || !tableName) return null;
    return loadUserProfileRow(tableName, id);
  }

  async getProfilesByIds(
    userIds: ReadonlyArray<string | undefined>,
  ): Promise<Map<string, UserProfileFields>> {
    const unique = [
      ...new Set(userIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id))),
    ];
    const tableName = userTableName();
    const map = new Map<string, UserProfileFields>();

    if (unique.length === 0 || !tableName) return map;

    try {
      return await loadProfilesForIds(tableName, unique);
    } catch (err) {
      if (!isValidationException(err)) return map;
      try {
        return await loadProfilesForIds(tableName, unique, true);
      } catch {
        return map;
      }
    }
  }
}

let userProfileRepository: UserProfileRepository | undefined;

export function getUserProfileRepository(): UserProfileRepository {
  if (!userProfileRepository) userProfileRepository = new UserProfileRepository();
  return userProfileRepository;
}

/** Test seam. */
export function resetUserProfileRepositoryForTests(): void {
  userProfileRepository = undefined;
}
