import type { DynamoDBStreamEvent } from 'aws-lambda';

const processCandidates = jest.fn();

jest.mock('@api-hub/workflow-runtime-core', () => ({
  OutboxRelayService: jest.fn().mockImplementation(() => ({
    processCandidates,
  })),
  extractOutboxInsertCandidates: jest.fn((records: unknown[]) =>
    (records as { eventID?: string }[])
      .filter((r) => r.eventID === 'keep')
      .map((r) => ({
        streamEventId: r.eventID!,
        record: { eventId: '01EV' },
      })),
  ),
}));

jest.mock('../../config/env', () => ({
  getWorkflowTableName: () => 'workflow-service-dev',
}));

import { main } from './outboxRelay';

describe('outboxRelay handler', () => {
  beforeEach(() => {
    processCandidates.mockReset();
  });

  it('returns empty failures when no outbox candidates', async () => {
    const event = {
      Records: [{ eventID: 'skip', eventName: 'INSERT' }],
    } as DynamoDBStreamEvent;

    const result = await main(event, {} as never, () => undefined);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(processCandidates).not.toHaveBeenCalled();
  });

  it('maps failed stream ids to batchItemFailures', async () => {
    processCandidates.mockResolvedValue({
      failedStreamEventIds: ['keep'],
      published: 0,
      skippedAlreadyPublished: 0,
      failed: 1,
      ignored: 0,
    });

    const event = {
      Records: [{ eventID: 'keep', eventName: 'INSERT' }],
    } as DynamoDBStreamEvent;

    const result = await main(event, {} as never, () => undefined);
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'keep' }],
    });
  });
});
