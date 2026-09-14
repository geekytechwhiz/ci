import {
  UserProfileRepository,
  resolveUserDisplayName,
  resolveUserEmail,
} from './user-profile.repository';

const mockSend = jest.fn();

jest.mock('@api-hub/utils', () => ({
  ddbDocClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

beforeAll(() => {
  process.env.USER_TABLE = 'user-table-stg';
});

function commandName(cmd: unknown): string {
  return (cmd as { constructor?: { name?: string } })?.constructor?.name ?? '';
}

function getKey(cmd: unknown): Record<string, string> | undefined {
  return (cmd as { input?: { Key?: Record<string, string> } })?.input?.Key;
}

function batchKeys(cmd: unknown): Record<string, string>[] {
  return (
    (cmd as { input?: { RequestItems?: Record<string, { Keys?: Record<string, string>[] }> } })
      ?.input?.RequestItems?.['user-table-stg']?.Keys ?? []
  );
}

describe('UserProfileRepository', () => {
  const repo = new UserProfileRepository();

  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('resolveUserDisplayName', () => {
    it('prefers fullName over email', () => {
      expect(
        resolveUserDisplayName({
          fullName: 'Root Admin',
          emailAddress: 'rootadmin1@yopmail.com',
          firstName: 'Root',
        }),
      ).toBe('Root Admin');
    });

    it('uses first+last when fullName missing', () => {
      expect(
        resolveUserDisplayName({
          firstName: 'Root',
          lastName: 'Admin',
          emailAddress: 'rootadmin1@yopmail.com',
        }),
      ).toBe('Root Admin');
    });

    it('falls back to email when names missing', () => {
      expect(
        resolveUserDisplayName({
          emailAddress: 'rootadmin1@yopmail.com',
        }),
      ).toBe('rootadmin1@yopmail.com');
    });
  });

  describe('resolveUserEmail', () => {
    it('reads emailAddress', () => {
      expect(resolveUserEmail({ emailAddress: 'a@b.com' })).toBe('a@b.com');
    });
  });

  describe('getByUserId', () => {
    it('loads ORG#ROOT / USER#id when USER# / ORG#ROOT is missing', async () => {
      const userId = '01K0AWQ7M8YV9F4T2X6RZJH3NB';
      mockSend.mockImplementation(async (cmd: unknown) => {
        const name = commandName(cmd);
        if (name === 'GetCommand') {
          const key = getKey(cmd) ?? {};
          if (key.pk === `USER#${userId}` && key.sk === 'ORG#ROOT') {
            return { Item: undefined };
          }
          if (key.pk === 'ORG#ROOT' && key.sk === `USER#${userId}`) {
            return {
              Item: {
                pk: 'ORG#ROOT',
                sk: `USER#${userId}`,
                userID: userId,
                fullName: 'Root Admin',
                emailAddress: 'rootadmin1@yopmail.com',
              },
            };
          }
          return { Item: undefined };
        }
        if (name === 'QueryCommand') {
          return { Items: [] };
        }
        return {};
      });

      const row = await repo.getByUserId(userId);
      expect(row?.fullName).toBe('Root Admin');
      expect(row?.emailAddress).toBe('rootadmin1@yopmail.com');
    });

    it('skips sparse USER#/ORG#ROOT and uses ORG#ROOT/USER# fullName (STG shape)', async () => {
      const userId = '88a9a6e052092188660a404a303ca34c992caabfccfc184ca2121fcac2d84e7f';
      mockSend.mockImplementation(async (cmd: unknown) => {
        const name = commandName(cmd);
        if (name === 'GetCommand') {
          const key = getKey(cmd) ?? {};
          if (key.pk === `USER#${userId}` && key.sk === 'ORG#ROOT') {
            return { Item: { pk: `USER#${userId}`, sk: 'ORG#ROOT' } };
          }
          if (key.pk === `USER#${userId}` && key.sk === 'USER_BASIC_DETAILS#ROOT') {
            return { Item: { pk: `USER#${userId}`, sk: 'USER_BASIC_DETAILS#ROOT' } };
          }
          if (key.pk === 'ORG#ROOT' && key.sk === `USER#${userId}`) {
            return {
              Item: {
                pk: 'ORG#ROOT',
                sk: `USER#${userId}`,
                userID: userId,
                fullName: 'Root Admin',
                firstName: 'Root',
                lastName: '',
                emailAddress: 'rootadmin@yopmail.com',
              },
            };
          }
          return { Item: undefined };
        }
        if (name === 'QueryCommand') {
          return { Items: [{ pk: `USER#${userId}`, sk: 'ORG#ROOT' }] };
        }
        return {};
      });

      const row = await repo.getByUserId(userId);
      expect(row?.fullName).toBe('Root Admin');
      expect(resolveUserDisplayName(row!)).toBe('Root Admin');
    });
  });

  describe('getProfilesByIds', () => {
    it('batch-falls back to ORG#ROOT / USER#id for missing profiles', async () => {
      const userId = '01K0AWQ7M8YV9F4T2X6RZJH3NB';
      mockSend.mockImplementation(async (cmd: unknown) => {
        const name = commandName(cmd);
        if (name === 'BatchGetCommand') {
          const keys = batchKeys(cmd);
          const first = keys[0];
          if (first?.pk?.startsWith('USER#') && first?.sk === 'ORG#ROOT') {
            return { Responses: { 'user-table-stg': [] } };
          }
          if (first?.sk === 'USER_BASIC_DETAILS#ROOT') {
            return { Responses: { 'user-table-stg': [] } };
          }
          if (first?.pk === 'ORG#ROOT') {
            return {
              Responses: {
                'user-table-stg': [
                  {
                    pk: 'ORG#ROOT',
                    sk: `USER#${userId}`,
                    userID: userId,
                    fullName: 'Root Admin',
                    emailAddress: 'rootadmin1@yopmail.com',
                  },
                ],
              },
            };
          }
          return { Responses: { 'user-table-stg': [] } };
        }
        if (name === 'QueryCommand') {
          return { Items: [] };
        }
        return {};
      });

      const map = await repo.getProfilesByIds([userId]);
      expect(map.get(userId)?.displayName).toBe('Root Admin');
      expect(map.get(userId)?.email).toBe('rootadmin1@yopmail.com');
    });

    it('continues past sparse USER#/ORG#ROOT to ORG#ROOT profile (STG shape)', async () => {
      const userId = '88a9a6e052092188660a404a303ca34c992caabfccfc184ca2121fcac2d84e7f';
      mockSend.mockImplementation(async (cmd: unknown) => {
        const name = commandName(cmd);
        if (name === 'BatchGetCommand') {
          const keys = batchKeys(cmd);
          const first = keys[0];
          if (first?.pk?.startsWith('USER#') && first?.sk === 'ORG#ROOT') {
            return {
              Responses: {
                'user-table-stg': [{ pk: `USER#${userId}`, sk: 'ORG#ROOT' }],
              },
            };
          }
          if (first?.sk === 'USER_BASIC_DETAILS#ROOT') {
            return {
              Responses: {
                'user-table-stg': [{ pk: `USER#${userId}`, sk: 'USER_BASIC_DETAILS#ROOT' }],
              },
            };
          }
          if (first?.pk === 'ORG#ROOT') {
            return {
              Responses: {
                'user-table-stg': [
                  {
                    pk: 'ORG#ROOT',
                    sk: `USER#${userId}`,
                    userID: userId,
                    fullName: 'Root Admin',
                    emailAddress: 'rootadmin@yopmail.com',
                  },
                ],
              },
            };
          }
          return { Responses: { 'user-table-stg': [] } };
        }
        if (name === 'QueryCommand') {
          return { Items: [{ pk: `USER#${userId}`, sk: 'ORG#ROOT' }] };
        }
        return {};
      });

      const map = await repo.getProfilesByIds([userId]);
      expect(map.get(userId)?.displayName).toBe('Root Admin');
      expect(map.get(userId)?.email).toBe('rootadmin@yopmail.com');
    });
  });
});
